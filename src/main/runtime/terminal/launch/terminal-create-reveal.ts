import type { RetainedTerminalStartError } from '../../../../shared/workspace-layout/retained-terminal-start'
import type { RetainedTerminalStart } from '../../../../shared/workspace-layout/retained-terminal-start'
import type { TerminalCreateOptions } from './terminal-create-options'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import { createTerminalRevealWarning, ownerSurfacing } from './terminal-presentation'
import type { RuntimeNotifier } from '../../client/events/runtime-notifier-contract'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeTerminalPresentation } from '../../../../shared/runtime-terminal-contracts'

function terminalRevealViewerOptions(
  opts: Pick<TerminalCreateOptions, 'surfaceOwner' | 'agentLaunchViewer'>
) {
  return {
    ...ownerSurfacing(opts.surfaceOwner !== false),
    ...(opts.agentLaunchViewer ? { agentLaunchViewer: opts.agentLaunchViewer() } : {})
  }
}

export function revealCreatedTerminal(args: {
  notifier: Pick<RuntimeNotifier, 'revealTerminalSession' | 'rememberLaunchRecipe'> | null
  workspace: Pick<TerminalWorkspaceLaunchScope, 'id' | 'path'>
  ptyId: string
  handle: string
  cwd: string
  launchOpts: TerminalCreateOptions
  effectiveLaunchConfig: TerminalCreateOptions['launchConfig']
  launchToken: string | undefined
  /** An adopted pane already ran; its recipe and spent launch token must not be re-registered. */
  adoptedStablePane: boolean
  presentation: RuntimeTerminalPresentation | undefined
  opts: TerminalCreateOptions
  tabId: string
  leafId: string
}):
  | Pick<RuntimeTerminalCreate, 'surface' | 'warning'>
  | Promise<Pick<RuntimeTerminalCreate, 'surface' | 'warning'>> {
  const {
    notifier,
    workspace,
    ptyId,
    handle,
    cwd,
    launchOpts,
    effectiveLaunchConfig,
    launchToken,
    adoptedStablePane,
    presentation,
    opts,
    tabId,
    leafId
  } = args
  const reveal = notifier?.revealTerminalSession?.bind(notifier)
  const rememberLaunchRecipe = (): void => {
    if (effectiveLaunchConfig && !adoptedStablePane) {
      notifier?.rememberLaunchRecipe?.({
        tabId,
        leafId,
        launchConfig: effectiveLaunchConfig,
        ...(launchToken ? { launchToken } : {}),
        ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {})
      })
    }
  }
  if (presentation !== 'background' && reveal) {
    return (async () => {
      try {
        await reveal(workspace.id, {
          ptyId,
          title: launchOpts.title ?? null,
          ...(cwd !== workspace.path ? { cwd } : {}),
          ...(effectiveLaunchConfig ? { launchConfig: effectiveLaunchConfig } : {}),
          ...(launchToken ? { launchToken } : {}),
          ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {}),
          ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
          ...(launchOpts.targetGroupId ? { targetGroupId: launchOpts.targetGroupId } : {}),
          ...(launchOpts.afterTabId ? { afterTabId: launchOpts.afterTabId } : {}),
          ...(launchOpts.shellOverride ? { shellOverride: launchOpts.shellOverride } : {}),
          ...(launchOpts.split ? { split: launchOpts.split } : {}),
          activate: presentation === 'focused',
          ...(presentation ? { presentation } : {}),
          ...terminalRevealViewerOptions(opts),
          tabId,
          leafId
        })
        return { surface: 'visible' as const }
      } catch (err) {
        console.warn(`[terminal-create] failed to create inactive tab for ${ptyId}:`, err)
        rememberLaunchRecipe()
        return {
          surface: 'background' as const,
          warning: createTerminalRevealWarning(handle, err)
        }
      }
    })()
  }
  rememberLaunchRecipe()
  return {
    surface: 'background',
    warning: presentation !== 'background' ? createTerminalRevealWarning(handle) : undefined
  }
}

export async function revealRetainedTerminalStart(args: {
  notifier: Pick<RuntimeNotifier, 'revealTerminalSession'> | null
  start: RetainedTerminalStart
  opts: TerminalCreateOptions
  splitFromLeafId?: string
  splitDirection?: 'horizontal' | 'vertical'
}): Promise<void> {
  const { notifier, start, opts } = args
  await notifier?.revealTerminalSession?.(start.worktreeId, {
    retainedTerminalStart: start,
    tabId: start.tabId,
    leafId: start.leafId,
    cwd: opts.cwd,
    shellOverride: opts.shellOverride,
    targetGroupId: opts.targetGroupId,
    afterTabId: opts.afterTabId,
    split: opts.split,
    viewMode: opts.viewMode,
    activate: opts.presentation === 'focused',
    presentation: opts.presentation ?? 'background',
    ...(args.splitFromLeafId ? { splitFromLeafId: args.splitFromLeafId } : {}),
    ...(args.splitDirection ? { splitDirection: args.splitDirection } : {})
  })
}

export function revealRetainedFailure(
  notifier: Pick<RuntimeNotifier, 'revealTerminalSession'> | null,
  error: RetainedTerminalStartError,
  launchOpts: TerminalCreateOptions,
  { cwd, presentation }: Pick<TerminalCreateOptions, 'cwd' | 'presentation'>
): Promise<void> {
  return revealRetainedTerminalStart({
    notifier,
    start: error.data.retainedTerminalStart,
    opts: { ...launchOpts, cwd, presentation }
  }).catch((publicationError: unknown) => {
    console.warn('[terminal] failed to show retained start:', publicationError)
  })
}
