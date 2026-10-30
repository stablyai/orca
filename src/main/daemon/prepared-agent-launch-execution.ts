import type { PreparedTerminalPrompts } from './prepared-agent-launch-protocol'
import type { PtyCreationDisposition } from '../../shared/claimed-agent-pty-owner'
import {
  agentSessionOperationKey,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import type {
  ClaimedAgentPtyOwnerRegistry,
  PreparedAgentPtyOwner
} from '../../shared/claimed-agent-pty-owner'
import { createSetupCompletionScanner } from '../runtime/orchestration/setup-completion-signal'
import type { InternalCreateOrAttachOptions } from './terminal-host-agent-session-claim'
import type { CreateOrAttachResult } from './terminal-host-create-contract'
import type {
  PreparedAgentLaunchStatus,
  PreparedAgentSpawn
} from './prepared-agent-launch-protocol'

export const PREPARED_LAUNCH_CALLER_KEY = 'prepared-agent-launch-v1'
const CALLER_KEY = PREPARED_LAUNCH_CALLER_KEY

// Execution state lives only with the physical owner; saved descriptors can rejoin it, never replay it.
export type LaunchWork = {
  owner: PreparedAgentPtyOwner
  status: PreparedAgentLaunchStatus
  launch?: PreparedAgentSpawn
  prompts?: PreparedTerminalPrompts
  promptClaimed?: boolean
  cancelDeadline?: () => void
  releaseCapacity?: () => void
  changed: Set<() => void>
  physicalEnded: boolean
}

export type PreparedLaunchDependencies = {
  owners: ClaimedAgentPtyOwnerRegistry
  create: (options: InternalCreateOrAttachOptions) => Promise<CreateOrAttachResult>
  isAlive: (sessionId: string) => boolean
  reserveCapacity: () => () => void
  now?: () => number
}

export abstract class PreparedAgentLaunchExecution {
  protected rows = new Map<string, AgentSessionOperationRow>()
  protected readonly now: () => number
  constructor(protected readonly deps: PreparedLaunchDependencies) {
    this.now = deps.now ?? Date.now
  }
  protected abstract notify(work: LaunchWork): void

  protected async startSetup(
    work: LaunchWork,
    setup: { spawn: PreparedAgentSpawn; attemptId: string }
  ) {
    const complete = (exitCode: number) => {
      if (!work.status.setup) {
        return
      }
      work.status.setup.exitCode = exitCode
      if (exitCode === 0) {
        void this.dispatch(work)
      } else {
        this.retireUnstarted(work, 'setup-failed')
      }
    }
    try {
      const result = await this.deps.create({
        ...setup.spawn,
        spawnAdmission: {
          clientId: CALLER_KEY,
          declaredIntent: setup.spawn.spawnIntent ?? null,
          deadlineAt: Infinity
        },
        streamClient: { onData() {}, onExit() {} },
        rawSpawnObserver: () => {
          let selected = false
          let ended = false
          let exitCode: number | undefined
          const scanner = createSetupCompletionScanner(setup.attemptId, (code) => {
            exitCode = code
            if (selected) {
              complete(code)
            }
          })
          return {
            onData: scanner.scan,
            onExit: () => {
              ended = true
              if (selected) {
                this.retireUnstarted(work, 'setup-ended')
              }
            },
            onSelected: () => {
              selected = true
              if (exitCode !== undefined) {
                complete(exitCode)
              } else if (ended) {
                this.retireUnstarted(work, 'setup-ended')
              }
            }
          }
        }
      })
      if (work.status.setup) {
        work.status.setup.incarnationId = result.incarnationId
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
      } else if (!work.status.physical && work.status.retirement !== 'unused-retired') {
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
    work.launch = undefined
    work.prompts = undefined
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

  private settlePhysicalEnd(work: LaunchWork): void {
    work.physicalEnded = true
    work.status.execution = 'settled'
    work.status.retirement = 'unused-retired'
    work.launch = undefined
    work.prompts = undefined
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
    work.launch = undefined
    work.prompts = undefined
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
