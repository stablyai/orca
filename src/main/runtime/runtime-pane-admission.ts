import { toSshExecutionHostId } from '../../shared/execution-host'
import type {
  TerminalPaneAdmission,
  TerminalPaneAdmissionOutcome
} from '../persistence/terminal-topology/terminal-pane-admission'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeStore } from './runtime-store-contract'

type Spawn = NonNullable<RuntimePtyController['spawn']>
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

/** Never the user's close: main stops no launch for it, unlike a window's closePane. */
async function withdrawAdmittedPane(
  store: RuntimeStore | null | undefined,
  admission: TerminalPaneAdmission,
  hostId: string | undefined
): Promise<void> {
  const leafId = admission.type === 'createTerminalTab' ? admission.leafId : admission.newLeafId
  await store?.withdrawTerminalPane?.(
    { type: 'closePane', workspace: admission.workspace, tabId: admission.tabId, leafId },
    hostId
  )
}

/** Writes a pane the runtime asks for into main's copy; what fills it is the caller's. */
export async function admitRuntimePane(
  store: RuntimeStore | null | undefined,
  admission: TerminalPaneAdmission,
  hostId: string | undefined
): Promise<TerminalPaneAdmissionOutcome | undefined> {
  return store?.admitTerminalPane?.(admission, hostId)
}

/**
 * Writes a pane before what fills it starts (design 4.1), then runs `start`. A start that fails
 * takes back a pane this wrote.
 */
export async function startInAdmittedPane<T>(
  store: RuntimeStore | null | undefined,
  admission: TerminalPaneAdmission,
  hostId: string | undefined,
  start: (outcome: TerminalPaneAdmissionOutcome | undefined) => Promise<T>
): Promise<{ outcome: TerminalPaneAdmissionOutcome | undefined; result: T }> {
  const outcome = await admitRuntimePane(store, admission, hostId)
  try {
    return { outcome, result: await start(outcome) }
  } catch (error) {
    if (outcome === 'admitted') {
      await withdrawAdmittedPane(store, admission, hostId)
    }
    throw error
  }
}

/**
 * Starts a runtime-originated terminal: its pane, tab-bar entry and group are written first, then
 * the process starts and binds to that pane. A start that fails, or that attaches to a session
 * already running in another pane, takes back the pane it wrote.
 */
export async function spawnInAdmittedPane(
  store: RuntimeStore | null | undefined,
  controller: Pick<RuntimePtyController, 'spawn'>,
  args: AdmittedSpawnArgs
): ReturnType<Spawn> {
  const { groupId: _groupId, afterTabId: _afterTabId, ...spawnArgs } = args
  const { outcome, result } = await startInAdmittedPane(
    store,
    admissionFor(args),
    hostIdOf(args),
    async (admitted) => {
      if (admitted !== undefined && admitted !== 'admitted' && admitted !== 'exists') {
        // Only a split is refused: its parent pane left the layout.
        throw new Error('terminal_split_source_not_found')
      }
      // SAFETY: Callers require spawn; a lost capability during admission keeps the original failure.
      return controller.spawn!(spawnArgs)
    }
  )
  const started = result.agentSessionEnsure?.owner.surface ?? result.stablePaneOwner
  const elsewhere = started && (started.tabId !== args.tabId || started.leafId !== args.leafId)
  if (outcome === 'admitted' && elsewhere) {
    await withdrawRuntimePane(store, args)
  }
  return result
}
