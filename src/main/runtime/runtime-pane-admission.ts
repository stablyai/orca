import { toSshExecutionHostId } from '../../shared/execution-host'
import type { TerminalPaneAdmission } from '../persistence/terminal-topology/terminal-pane-admission'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeStore } from './runtime-store-contract'

type Spawn = NonNullable<RuntimePtyController['spawn']>
type AdmittedSpawnArgs = Parameters<Spawn>[0] & {
  worktreeId: string
  tabId: string
  leafId: string
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
  const viewMode = placement?.kind === 'new-tab' ? placement.row?.viewMode : undefined
  return {
    type: 'createTerminalTab',
    workspace,
    tabId,
    leafId,
    ...(viewMode ? { viewMode } : {}),
    ...(args.cwd ? { creation: { startupCwd: args.cwd } } : {})
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
  await store?.withdrawTerminalPane?.(
    { type: 'closePane', workspace: args.worktreeId, tabId: args.tabId, leafId: args.leafId },
    hostIdOf(args)
  )
}

/**
 * Starts a runtime-originated terminal (design 4.1): its pane, tab-bar entry and group are written
 * first, then the process starts and binds to that pane. A start that fails, or that attaches to a
 * session already running in another pane, takes back the pane it wrote.
 */
export async function spawnInAdmittedPane(
  store: RuntimeStore | null | undefined,
  controller: Required<Pick<RuntimePtyController, 'spawn'>>,
  args: AdmittedSpawnArgs
): ReturnType<Spawn> {
  const outcome = await store?.admitTerminalPane?.(admissionFor(args), hostIdOf(args))
  if (outcome !== undefined && outcome !== 'admitted' && outcome !== 'exists') {
    // Only a split is refused: its parent pane left the layout.
    throw new Error('terminal_split_source_not_found')
  }
  let result: Awaited<ReturnType<Spawn>>
  try {
    result = await controller.spawn(args)
  } catch (error) {
    if (outcome === 'admitted') {
      await withdrawRuntimePane(store, args)
    }
    throw error
  }
  const started = result.agentSessionEnsure?.owner.surface ?? result.stablePaneOwner
  const elsewhere = started && (started.tabId !== args.tabId || started.leafId !== args.leafId)
  if (outcome === 'admitted' && elsewhere) {
    await withdrawRuntimePane(store, args)
  }
  return result
}
