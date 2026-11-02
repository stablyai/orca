import {
  agentSessionOperationKey,
  type AgentSessionOperationRow
} from '../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import type {
  ClaimedAgentPtyOwnerRegistry,
  PreparedAgentPtyOwner,
  PtyCreationDisposition
} from '../../shared/claimed-agent-pty-owner'
import { SETUP_STATUS_FILE_ENV } from '../../shared/observed-setup-launch'
import { observeSetupStatus } from './prepared-setup-status'
import { isOneLine, lineAboveCursor } from './setup-outcome-line'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import type {
  PreparedAgentLaunchStatus,
  PreparedAgentSpawn
} from './prepared-agent-launch-protocol'
import type {
  PreparedLaunchIncarnation,
  PreparedLaunchPublication
} from '../../shared/prepared-agent-launch'

export const PREPARED_LAUNCH_CALLER_KEY = 'prepared-agent-launch-v1'
const CALLER_KEY = PREPARED_LAUNCH_CALLER_KEY

// Execution state lives only with the physical owner; saved descriptors can rejoin it, never replay it.
export type LaunchWork = {
  owner: PreparedAgentPtyOwner
  status: PreparedAgentLaunchStatus
  launch?: PreparedAgentSpawn
  /** Retained until input retirement so recovery publishes the accepted recipe, view and authority. */
  publication?: PreparedLaunchPublication
  stopSetupScan?: () => void
  /** The exact Setup process while it runs; a replacement under its id is never returned. */
  liveSetup?: () => SetupOutputSession | undefined
  /** The one answer to main's Setup line, kept with the launch so a repeat never writes again. */
  setupOutcomeWritten?: boolean
  cancelDeadline?: () => void
  releaseCapacity?: () => void
  changed: Set<() => void>
  physicalEnded: boolean
}

export type SetupOutputSession = {
  isAlive: boolean
  incarnationId: string
  terminalHandle: string | null
  paneKey?: string
  startupIngress: { accept(data: string): void }
  cols?: number
}

export type PreparedLaunchDependencies = {
  owners: ClaimedAgentPtyOwnerRegistry
  create: (options: InternalCreateOrAttachOptions) => Promise<CreateOrAttachResult>
  isAlive: (sessionId: string) => boolean
  reserveCapacity: () => () => void
  /** The live session under a Setup id, whose output can take main's explanation. */
  setupSession?: (sessionId: string) => SetupOutputSession | undefined
  /** A host shutting down admits no new preparation or acceptance. */
  fenced?: () => boolean
  now?: () => number
}

/** Read after an await: a failed creation can retire the launch while its dispatch is in flight. */
function isUnusedRetired(status: PreparedAgentLaunchStatus): boolean {
  return status.retirement === 'unused-retired'
}

export abstract class PreparedAgentLaunchExecution {
  protected rows = new Map<string, AgentSessionOperationRow>()
  /** This daemon's incarnation, once read; it owns staged files for crash collection. */
  protected incarnation?: PreparedLaunchIncarnation
  protected readonly now: () => number
  constructor(protected readonly deps: PreparedLaunchDependencies) {
    this.now = deps.now ?? Date.now
  }
  protected abstract notify(work: LaunchWork): void

  protected async startSetup(
    work: LaunchWork,
    setup: { spawn: PreparedAgentSpawn; attemptId: string }
  ) {
    // Whether a spawn attempt became this Setup; a replaced ConPTY attempt never does.
    let selected = false
    let exitCode: number | undefined
    const complete = (code: number) => {
      if (!work.status.setup) {
        return
      }
      work.status.setup.exitCode = code
      if (code === 0) {
        void this.dispatch(work)
      } else {
        this.retireUnstarted(work, 'setup-failed')
      }
    }
    try {
      // Completion leaves through a file this daemon owns, never through the Setup terminal.
      const status = observeSetupStatus({
        owner: this.incarnation,
        attemptId: setup.attemptId,
        onStatus: (code) => {
          exitCode = code
          if (selected) {
            complete(code)
          }
        }
      })
      // Settlement removes the file's directory: a late status after cancel or deadline lands nowhere.
      work.stopSetupScan = status.stop
      const result = await this.deps.create({
        ...setup.spawn,
        env: { ...setup.spawn.env, [SETUP_STATUS_FILE_ENV]: status.path },
        spawnAdmission: {
          clientId: CALLER_KEY,
          declaredIntent: setup.spawn.spawnIntent ?? null,
          deadlineAt: Infinity
        },
        streamClient: { onData() {}, onExit() {} },
        rawSpawnObserver: () => {
          let mine = false
          let ended = false
          // The wrapper writes the status before Setup's shell exits; read it before calling the exit early.
          const settleEnded = () =>
            void status.check().then(() => {
              if (exitCode === undefined) {
                this.retireUnstarted(work, 'setup-ended')
              }
            })
          return {
            onExit: () => {
              ended = true
              if (mine) {
                settleEnded()
              }
            },
            onSelected: () => {
              mine = true
              selected = true
              if (exitCode !== undefined) {
                complete(exitCode)
              } else if (ended) {
                settleEnded()
              }
            }
          }
        }
      })
      if (work.status.setup) {
        work.status.setup.incarnationId = result.incarnationId
      }
      work.liveSetup = () => {
        const session = this.deps.setupSession?.(setup.spawn.sessionId)
        return session?.isAlive && session.incarnationId === result.incarnationId
          ? session
          : undefined
      }
      this.notify(work)
    } catch {
      this.retireUnstarted(work, 'spawn-failed')
    }
  }

  protected async dispatch(work: LaunchWork): Promise<void> {
    if (
      work.status.execution !== 'not-dispatched' ||
      work.status.retirement === 'unused-retired' ||
      !work.launch
    ) {
      return
    }
    // No await between cancellation's check and taking the sole physical-dispatch right.
    work.status.execution = 'dispatching'
    work.cancelDeadline?.()
    const launch = work.launch
    const startedAt = this.now()
    this.notify(work)
    const creation = Promise.withResolvers<PtyCreationDisposition>()
    try {
      await this.deps.owners.dispatchPrepared(work.owner, {
        creation: creation.promise,
        isLive: (owner) => !work.physicalEnded && this.deps.isAlive(owner.ptyId),
        spawn: async ({ generation }) => {
          const result = await this.deps.create({
            ...launch,
            spawnAdmission: {
              clientId: CALLER_KEY,
              declaredIntent: launch.spawnIntent ?? null,
              deadlineAt: Infinity
            },
            agentSessionGeneration: generation,
            retainOnPublicationFailure: true,
            ...(this.incarnation ? { ownedStaging: this.incarnation } : {}),
            onCreationDisposition: (disposition) => {
              creation.resolve(disposition)
              if (disposition.kind === 'physical') {
                void disposition.completion.then(() => this.settlePhysicalEnd(work))
              } else if (disposition.kind === 'no-fork' || disposition.kind === 'failed') {
                const retire = () => this.retireFailedCreation(work)
                if (disposition.kind === 'failed') {
                  void disposition.completion.then(retire)
                } else {
                  retire()
                }
              }
            },
            reservedCapacity: work.releaseCapacity,
            streamClient: { onData() {}, onExit() {} },
            onPhysicalOwner: (completion) => {
              void completion.then(() => {
                this.settlePhysicalEnd(work)
              })
            }
          })
          work.status.physical = {
            sessionId: launch.sessionId,
            incarnationId: result.incarnationId,
            startedAt
          }
          work.status.execution = work.physicalEnded ? 'settled' : 'started'
          work.status.retirement = work.physicalEnded ? 'unused-retired' : 'retained-live'
          work.launch = undefined
          const row = this.rows.get(agentSessionOperationKey(CALLER_KEY, work.status.operationId))
          if (row) {
            row.outcome = { status: 'succeeded', sessionId: '' }
            if (work.physicalEnded) {
              delete row.preparedLaunch
            }
          }
          return { ptyId: launch.sessionId }
        }
      })
    } catch {
      // A failure after native dispatch is not proof that no process exists.
      if (work.physicalEnded) {
        this.settlePhysicalEnd(work)
      } else if (!work.status.physical && !isUnusedRetired(work.status)) {
        work.status.execution = 'unknown'
        work.status.retirement = 'unknown'
        work.status.failure = 'spawn-failed'
      }
    }
    if (work.status.execution !== 'unknown') {
      work.releaseCapacity?.()
      work.releaseCapacity = undefined
    }
    this.notify(work)
  }

  protected retireUnstarted(work: LaunchWork, failure: PreparedAgentLaunchStatus['failure']): void {
    if (work.status.execution !== 'not-dispatched' || work.status.retirement === 'unused-retired') {
      return
    }
    if (!this.deps.owners.cancelPrepared(work.owner)) {
      return
    }
    work.status.execution = 'settled'
    work.status.retirement = 'unused-retired'
    work.status.failure = failure
    work.stopSetupScan?.()
    this.clearLaunchPayload(work)
    work.cancelDeadline?.()
    work.releaseCapacity?.()
    work.releaseCapacity = undefined
    const row = this.rows.get(agentSessionOperationKey(CALLER_KEY, work.status.operationId))
    if (row) {
      row.outcome = { status: 'failed', code: failure ?? 'cancelled' }
      delete row.preparedLaunch
    }
    this.notify(work)
  }

  /** Writes main's explanation into this launch's own Setup, only while that exact process runs. */
  protected writeSetupOutcome(work: LaunchWork, text: string): boolean {
    // Decided once: a repeat after a lost reply, even once Setup has closed, gets the same answer.
    if (work.setupOutcomeWritten === undefined) {
      const session = work.status.physical ? undefined : work.liveSetup?.()
      work.setupOutcomeWritten = session !== undefined && isOneLine(text)
      if (session && work.setupOutcomeWritten) {
        session.startupIngress.accept(lineAboveCursor(`[orca] ${text}`, session.cols))
      }
    }
    return work.setupOutcomeWritten
  }

  /** Command, env and authority die with the launch obligation; the status stays readable. */
  protected clearLaunchPayload(work: LaunchWork): void {
    work.launch = undefined
    work.publication = undefined
  }

  private settlePhysicalEnd(work: LaunchWork): void {
    work.physicalEnded = true
    work.status.execution = 'settled'
    work.status.retirement = 'unused-retired'
    this.clearLaunchPayload(work)
    work.releaseCapacity?.()
    work.releaseCapacity = undefined
    const row = this.rows.get(agentSessionOperationKey(CALLER_KEY, work.status.operationId))
    if (row) {
      row.outcome = { status: 'succeeded', sessionId: '' }
      delete row.preparedLaunch
    }
    this.notify(work)
  }

  private retireFailedCreation(work: LaunchWork): void {
    if (work.status.physical) {
      return
    }
    work.status.execution = 'settled'
    work.status.retirement = 'unused-retired'
    work.status.failure = 'spawn-failed'
    this.clearLaunchPayload(work)
    work.releaseCapacity?.()
    work.releaseCapacity = undefined
    const row = this.rows.get(agentSessionOperationKey(CALLER_KEY, work.status.operationId))
    if (row) {
      row.outcome = { status: 'failed', code: 'spawn-failed' }
      delete row.preparedLaunch
    }
    this.notify(work)
  }
}
