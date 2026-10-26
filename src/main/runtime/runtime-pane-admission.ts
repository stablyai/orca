import { PaneOwnerContentionError } from '../ipc/pty/pane/pane-spawn-operation'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toSshExecutionHostId
} from '../../shared/execution-host'
import { collectLeafIds } from '../../shared/terminal-pane-layout-tree'
import type {
  TerminalPaneAdmission,
  TerminalPaneAdmissionOutcome
} from '../persistence/terminal-topology/terminal-pane-admission'
import type { LayoutRefusalCode } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeStore } from './runtime-store-contract'
import type { PaneResumeOutcome } from '../../shared/workspace-layout/workspace-layout-published'
import {
  paneStartFailure,
  type PaneResumeOutcomes,
  type PaneStartStatuses
} from './pane-start-statuses'

type Spawn = NonNullable<RuntimePtyController['spawn']>
type PaneStartStatusSink = Pick<PaneStartStatuses, 'set' | 'clear'>
/** Main-owned/keepOnFailure panes retain failed start status. Each start clears prior resume outcome; only resumesSleepingRecord publishes a new one. */
export type PaneStartArgs = {
  startStatus?: {
    sink: PaneStartStatusSink
    keepOnFailure: boolean
    resumeOutcomes?: Pick<PaneResumeOutcomes, 'set' | 'clear'>
    resumesSleepingRecord?: boolean
  }
}
type AdmittedSpawnArgs = Parameters<Spawn>[0] & {
  worktreeId: string
  tabId: string
  leafId: string
  /** The group a new tab joins; a split stays in its parent's. */
  groupId?: string
  afterTabId?: string
}

/** The pane its placement names: a new tab, or a split beside its parent pane. */
function admissionFor(args: AdmittedSpawnArgs): TerminalPaneAdmission {
  const { worktreeId: workspace, tabId, leafId, placement } = args
  if (placement?.kind === 'split') {
    const { parentLeafId, direction } = placement
    return {
      type: 'splitPane',
      workspace,
      tabId,
      leafId: parentLeafId,
      direction,
      newLeafId: leafId
    }
  }
  const row = placement?.kind === 'new-tab' ? placement.row : undefined
  return {
    type: 'createTerminalTab',
    workspace,
    tabId,
    leafId,
    ...(args.groupId ? { groupId: args.groupId } : {}),
    ...(args.afterTabId ? { afterTabId: args.afterTabId } : {}),
    ...(row?.viewMode ? { viewMode: row.viewMode } : {}),
    ...(row?.customTitle ? { title: row.customTitle } : {}),
    ...(args.cwd || args.launchAgent || args.launchRuntime?.pty.shellOverride
      ? {
          creation: {
            ...(args.cwd ? { startupCwd: args.cwd } : {}),
            ...(args.launchAgent ? { launchAgent: args.launchAgent } : {}),
            ...(args.launchRuntime?.pty.shellOverride
              ? { shellOverride: args.launchRuntime.pty.shellOverride }
              : {})
          }
        }
      : {})
  }
}

function paneStillWritten(
  store: RuntimeStore | null | undefined,
  args: AdmittedSpawnArgs
): boolean {
  const layout = store?.getWorkspaceSession?.(hostIdOf(args))?.terminalLayoutsByTabId?.[args.tabId]
  return collectLeafIds(layout?.root).includes(args.leafId)
}

function hostIdOf(args: AdmittedSpawnArgs): string | undefined {
  return args.connectionId ? toSshExecutionHostId(args.connectionId) : undefined
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

/** Admit before starting (design 4.1); withdraw failed newly admitted panes unless keepOnFailure retains the error surface. */
export async function startInAdmittedPane<T>(
  store: RuntimeStore | null | undefined,
  admission: TerminalPaneAdmission,
  hostId: string | undefined,
  start: (outcome: TerminalPaneAdmissionOutcome | undefined) => Promise<T>,
  keepOnFailure = false
): Promise<{ outcome: TerminalPaneAdmissionOutcome | undefined; result: T }> {
  const outcome = await admitRuntimePane(store, admission, hostId)
  try {
    return { outcome, result: await start(outcome) }
  } catch (error) {
    if (outcome === 'admitted' && !keepOnFailure && !(error instanceof PaneOwnerContentionError)) {
      await withdrawAdmittedPane(store, admission, hostId)
    }
    throw error
  }
}

/** Publish pane/tab/group before spawn and mark starting early so views cannot race their own spawn.
 * Withdraw new panes on failure or attachment elsewhere, unless failure retention applies. */
export async function spawnInAdmittedPane(
  store: RuntimeStore | null | undefined,
  controller: Pick<RuntimePtyController, 'spawn'>,
  { startStatus, ...args }: AdmittedSpawnArgs & PaneStartArgs
): ReturnType<Spawn> {
  const { groupId: _groupId, afterTabId: _afterTabId, ...spawnArgs } = args
  const paneKey = `${args.tabId}:${args.leafId}`
  let admittedAs: TerminalPaneAdmissionOutcome | undefined
  startStatus?.sink.set(paneKey, { status: 'starting' })
  startStatus?.resumeOutcomes?.clear(paneKey)
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
  let run: { outcome: TerminalPaneAdmissionOutcome | undefined; result: Awaited<ReturnType<Spawn>> }
  const start = async (
    admitted: TerminalPaneAdmissionOutcome | undefined
  ): Promise<Awaited<ReturnType<Spawn>>> => {
    if (admitted !== undefined && admitted !== 'admitted' && admitted !== 'exists') {
      // A tab main recorded closed, or a split whose parent pane left the layout.
      throw new Error(
        admitted === 'tab_closed' ? 'tab_not_found' : 'terminal_split_source_not_found'
      )
    }
    admittedAs = admitted
    // SAFETY: Callers require spawn; a lost capability during admission keeps the original failure.
    return controller.spawn!(spawnArgs)
  }
  try {
    // A reconnect into its own pane skips admission: the pane is already written.
    run = args.paneSpawnOperation?.mustExist
      ? { outcome: undefined, result: await start('exists') }
      : await startInAdmittedPane(
          store,
          admissionFor(args),
          hostIdOf(args),
          start,
          startStatus?.keepOnFailure
        )
  } catch (error) {
    // Retained panes show failure; user-closed panes stay gone and contended panes attach to the winner.
    if (
      startStatus &&
      admittedAs &&
      !(error instanceof PaneOwnerContentionError) &&
      (startStatus.keepOnFailure || admittedAs === 'exists') &&
      paneStillWritten(store, args)
    ) {
      startStatus.sink.set(paneKey, paneStartFailure(error))
    } else {
      startStatus?.sink.clear(paneKey)
    }
    // Failed binding resumes nothing here; contention must leave the winner's outcome intact.
    if (!(error instanceof PaneOwnerContentionError)) {
      resumeOutcomes?.clear(paneKey)
    }
    throw error
  }
  startStatus?.sink.clear(paneKey)
  const { outcome, result } = run
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
