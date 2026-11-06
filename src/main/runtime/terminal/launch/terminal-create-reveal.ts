import type { TerminalCreateOptions } from './terminal-create-options'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-create-contract'
import { createTerminalRevealWarning, ownerSurfacing } from './terminal-presentation'
import type { RuntimeNotifier } from '../../runtime-notifier-contract'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { RuntimeTerminalPresentation } from '../../../../shared/runtime-types'

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
