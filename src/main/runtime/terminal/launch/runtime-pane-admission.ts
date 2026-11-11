import { PaneOwnerContentionError } from '../../../ipc/pty/pane/pane-spawn-operation'
import { requireAcceptedSpawn } from '../../../ipc/pty/spawn-outcome'
import type { PreparedPtySpawnSettlement } from '../../../ipc/pty/spawn-outcome'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { TerminalCreateOptions } from './terminal-create-options'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../shared/execution-host'
import type {
  TerminalPaneAdmission,
  TerminalPaneAdmissionOutcome
} from '../../../persistence/terminal-topology/terminal-pane-admission'
import type { LayoutRefusalCode } from '../../../../shared/workspace-layout/workspace-layout-command-types'
import type { RuntimePtyController } from '../lifecycle/runtime-pty-controller-contract'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { PaneResumeOutcome } from '../../../../shared/workspace-layout/workspace-layout-published'
import {
  paneStartFailure,
  type PaneStartFact,
  type PaneResumeOutcomes,
  type PaneStartStatuses
} from '../surface/pane-start-statuses'
import { RetainedTerminalStartError } from '../../../../shared/workspace-layout/retained-terminal-start'

import {
  admissionFor,
  hostIdOf,
  paneStillWritten,
  preparedAdmissionFor,
  type AdmittedSpawnArgs
} from './runtime-pane-placement'

type Spawn = NonNullable<RuntimePtyController['spawn']>
type PaneStartStatusSink = Pick<PaneStartStatuses, 'set' | 'clear' | 'peek' | 'nextStartSequence'>
/** Main-owned/keepOnFailure panes retain failed start status. Each start clears prior resume outcome; only resumesSleepingRecord publishes a new one. */
export type PaneStartArgs = {
  runtimeId?: string
  keepOnFailure?: boolean
  startStatus?: {
    sink: PaneStartStatusSink
    resumeOutcomes?: Pick<PaneResumeOutcomes, 'set' | 'clear'>
    resumesSleepingRecord?: boolean
  }
}

/** Takes back a pane the runtime wrote for a start that then failed, so it leaves no tab. */
export async function withdrawRuntimePane(
  store: RuntimeStore | null | undefined,
  args: AdmittedSpawnArgs
): Promise<void> {
  await withdrawAdmittedPane(store, admissionFor(args), hostIdOf(args))
}

/** Withdrawal is not user close and stops no launch; stillStarting preserves already-bound or starting panes. */
export async function withdrawAdmittedPane(
  store: RuntimeStore | null | undefined,
  admission: TerminalPaneAdmission,
  hostId: string | undefined,
  stillStarting?: () => boolean
): Promise<LayoutRefusalCode | 'bound' | 'starting' | null | undefined> {
  const leafId = admission.type === 'createTerminalTab' ? admission.leafId : admission.newLeafId
  const pane = {
    type: 'closePane' as const,
    workspace: admission.workspace,
    tabId: admission.tabId,
    leafId
  }
  return store?.withdrawTerminalPane?.(pane, hostId, stillStarting)
}

/** Writes a pane the runtime asks for into main's copy; what fills it is the caller's. */
export async function admitRuntimePane(
  store: RuntimeStore | null | undefined,
  admission: TerminalPaneAdmission,
  hostId: string | undefined
): Promise<TerminalPaneAdmissionOutcome | undefined> {
  return store?.admitTerminalPane?.(admission, hostId)
}

/** Publish pane/tab/group before spawn and mark starting early so views cannot race their own spawn.
 * Withdraw new panes on failure or attachment elsewhere, unless failure retention applies. */
export async function spawnInAdmittedPane(
  store: RuntimeStore | null | undefined,
  controller: Pick<RuntimePtyController, 'spawn'>,
  { startStatus, keepOnFailure, runtimeId, ...args }: AdmittedSpawnArgs & PaneStartArgs
): ReturnType<Spawn> {
  const { groupId: _groupId, afterTabId: _afterTabId, ...spawnArgs } = args
  const paneKey = `${args.tabId}:${args.leafId}`
  const retainedAttempt =
    args.paneSpawnOperation?.retainedAttempt ?? args.preparedReplacement?.retainedAttempt
  let admittedAs: TerminalPaneAdmissionOutcome | undefined
  const resumeOutcomes = startStatus?.resumesSleepingRecord ? startStatus.resumeOutcomes : undefined
  // Bindings start at 1; absent process-local history is generation 0.
  const generationNow = (): number | undefined =>
    store?.getPtyBindingGeneration
      ? (store.getPtyBindingGeneration(
          normalizeExecutionHostId(hostIdOf(args)) ?? LOCAL_EXECUTION_HOST_ID,
          args.leafId
        ) ?? 0)
      : undefined
  const afterGeneration = resumeOutcomes ? generationNow() : undefined
  let reported: { ptyId: string; outcome: PaneResumeOutcome } | undefined
  if (resumeOutcomes) {
    // Capture generation before spawn: terminal id may survive respawn, but the next binding is new.
    spawnArgs.onResumeOutcome = (ptyId, outcome) => {
      reported = { ptyId, outcome }
      resumeOutcomes.set(paneKey, outcome, { ptyId, afterGeneration })
    }
  }
  let result: Awaited<ReturnType<Spawn>>
  let admissionStarted = false
  let admittedGeneration: number | undefined
  let startingFact: PaneStartFact | undefined
  let startSequence: number | undefined
  let settlement: PreparedPtySpawnSettlement | undefined
  let admittedBinding: { ptyId: string | null; incarnationId?: string } | undefined
  const bindingNow = () => {
    const session = store?.getWorkspaceSession?.(hostIdOf(args))
    return {
      ptyId: session?.terminalLayoutsByTabId?.[args.tabId]?.ptyIdsByLeafId?.[args.leafId] ?? null,
      incarnationId: session?.terminalPtyIncarnationsByPaneKey?.[paneKey]
    }
  }
  const admitPreparedSpawn = async (): Promise<void> => {
    if (admissionStarted) {
      return
    }
    admissionStarted = true
    const admitted = args.paneSpawnOperation?.mustExist
      ? 'exists'
      : await admitRuntimePane(store, preparedAdmissionFor(store, args), hostIdOf(args))
    if (admitted !== undefined && admitted !== 'admitted' && admitted !== 'exists') {
      throw new Error(
        admitted === 'tab_closed' ? 'tab_not_found' : 'terminal_split_source_not_found'
      )
    }
    admittedAs = admitted
    admittedGeneration = generationNow()
    admittedBinding = bindingNow()
    startStatus?.resumeOutcomes?.clear(paneKey)
    if (retainedAttempt) {
      return
    }
    startingFact = {
      status: 'starting',
      inFlightOperation: args.paneSpawnOperation?.acquisition?.reservation ?? {}
    }
    startSequence = startStatus?.sink.nextStartSequence()
    if (runtimeId && admittedGeneration !== undefined && startSequence !== undefined) {
      startingFact.retainedTerminalStart = {
        worktreeId: args.worktreeId,
        runtimeId,
        executionHostId: normalizeExecutionHostId(hostIdOf(args)) ?? LOCAL_EXECUTION_HOST_ID,
        tabId: args.tabId,
        leafId: args.leafId,
        bindingGeneration: admittedGeneration,
        startSequence,
        status: 'starting',
        reason: ''
      }
    }
    startStatus?.sink.set(paneKey, startingFact)
  }
  try {
    // The prepared host operation admits before dispatch; adoption never writes a new pane.
    result = await controller.spawn!({
      ...spawnArgs,
      admitPreparedSpawn,
      onPreparedSpawnSettlement: (evidence) => {
        try {
          if (settlement) {
            return evidence.kind === 'outcome' ? undefined : evidence.error
          }
          settlement = evidence
          const current = startStatus?.sink.peek(paneKey)
          const ended =
            evidence.kind === 'outcome' && evidence.outcome.kind === 'registration-exited'
              ? evidence.outcome
              : null
          const binding = bindingNow()
          if (
            ended &&
            startingFact?.retainedTerminalStart &&
            startStatus &&
            keepOnFailure &&
            admittedAs &&
            (!current || current === startingFact) &&
            paneStillWritten(store, args) &&
            binding.ptyId === ended.result.id &&
            binding.incarnationId === ended.result.incarnationId
          ) {
            let failure: unknown
            try {
              requireAcceptedSpawn(ended)
            } catch (error) {
              failure = error
            }
            const status = paneStartFailure(failure)
            const retained = {
              ...startingFact.retainedTerminalStart,
              bindingGeneration:
                generationNow() ?? startingFact.retainedTerminalStart.bindingGeneration,
              status: 'failed' as const,
              reason: status.reason ?? ''
            }
            startStatus.sink.set(paneKey, {
              ...status,
              retainedTerminalStart: retained,
              retainedStartBinding: binding
            })
            return new RetainedTerminalStartError(failure, retained)
          }
          if (!startingFact || current !== startingFact) {
            return evidence.kind === 'outcome' ? undefined : evidence.error
          }
          if (evidence.kind === 'outcome' || evidence.kind === 'superseded') {
            startStatus?.sink.clear(paneKey, startingFact)
            return evidence.kind === 'outcome' ? undefined : evidence.error
          }
          if (
            !admittedAs ||
            generationNow() !== admittedGeneration ||
            !paneStillWritten(store, args) ||
            (binding.ptyId !== null &&
              (binding.ptyId !== admittedBinding?.ptyId ||
                binding.incarnationId !== admittedBinding?.incarnationId))
          ) {
            startStatus?.sink.clear(paneKey, startingFact)
            return evidence.error
          }
          if (evidence.kind === 'unknown') {
            delete startingFact.inFlightOperation
            return evidence.error
          }
          const failure = paneStartFailure(evidence.error)
          const retained = startingFact.retainedTerminalStart
          if (keepOnFailure && retained && startStatus) {
            const outcome = {
              ...retained,
              status: failure.status === 'held' ? ('held' as const) : ('failed' as const),
              reason: failure.reason ?? ''
            }
            startStatus.sink.set(paneKey, {
              ...failure,
              retainedTerminalStart: outcome,
              retainedStartBinding: startingFact.retainedStartBinding
            })
            return new RetainedTerminalStartError(evidence.error, outcome)
          }
          if (ORCA_LAYOUT_OWNER_IS_MAIN && admittedAs === 'exists') {
            startStatus?.sink.set(paneKey, failure)
          } else {
            startStatus?.sink.clear(paneKey, startingFact)
          }
          return evidence.error
        } finally {
          if (startingFact && startStatus?.sink.peek(paneKey) === startingFact) {
            delete startingFact.inFlightOperation
          }
        }
      }
    })
  } catch (error) {
    if (admittedAs === 'admitted' && !keepOnFailure && settlement?.kind === 'rejected') {
      await withdrawAdmittedPane(store, admissionFor(args), hostIdOf(args))
      if (args.paneSpawnOperation?.acquisition) {
        args.paneSpawnOperation.acquisition.surfaceWithdrawn = true
      }
    }
    if (
      settlement?.kind === 'rejected' ||
      (!settlement && !(error instanceof PaneOwnerContentionError))
    ) {
      resumeOutcomes?.clear(paneKey)
    }
    throw error
  } finally {
    if (startingFact && startStatus?.sink.peek(paneKey) === startingFact) {
      delete startingFact.inFlightOperation
    }
    if (startingFact && !startingFact.retainedTerminalStart) {
      startStatus?.sink.clear(paneKey, startingFact)
    }
  }
  if (startStatus?.sink.peek(paneKey) === startingFact) {
    startStatus?.sink.clear(paneKey, startingFact)
  }
  const outcome = admittedAs
  const started = result.agentSessionEnsure?.owner.surface ?? result.stablePaneOwner
  const elsewhere = started && (started.tabId !== args.tabId || started.leafId !== args.leafId)
  if (outcome === 'admitted' && elsewhere) {
    await withdrawRuntimePane(store, args)
  }
  if (elsewhere) {
    resumeOutcomes?.clear(paneKey)
  } else if (reported && afterGeneration !== undefined && generationNow() === afterGeneration) {
    // Same-id SSH reattach may publish no new binding; apply the outcome to the existing binding.
    resumeOutcomes?.set(paneKey, reported.outcome, { ptyId: reported.ptyId })
  }
  return result
}

export type PaneStartArgsOf = (opts: TerminalCreateOptions) => PaneStartArgs
