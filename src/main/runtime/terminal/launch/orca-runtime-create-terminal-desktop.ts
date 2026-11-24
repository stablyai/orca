import { applyRemoteViewerLaunchEnv } from './remote-viewer-launch-env'
import type { TerminalCreateOptions } from './terminal-create-options'
import type { RuntimeTerminalCreate } from '../../../../shared/terminal/runtime/runtime-terminal-create-contract'
import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import { ownerSurfacing } from './terminal-presentation'
import type { OrcaRuntimeWithCreateTerminal } from './terminal-create'
import type { RuntimeTerminalPresentation } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

// Without a window, the missing piece the caller can supply is the workspace, so name that.
const NO_WORKSPACE_OR_WINDOW_MESSAGE =
  'No workspace was given or found for this terminal, and this Orca host has no open app window to create one in. Pass --worktree to choose a workspace. No terminal was created.'

// Workspace-less creates target the window's current view, so only it can perform them.
export async function createDesktopTerminal(
  runtime: OrcaRuntimeWithCreateTerminal,
  opts: TerminalCreateOptions,
  presentation: RuntimeTerminalPresentation | undefined
): Promise<RuntimeTerminalCreate> {
  // Without a workspace there is no host on which to resolve a shell.
  if (opts.shellOverride) {
    throw new Error(
      `--shell ${opts.shellOverride} needs a workspace, because the shell is resolved on the workspace's execution host. No terminal was created.`
    )
  }
  opts = applyRemoteViewerLaunchEnv(opts, opts.terminalImageViewerSupported)
  runtime.assertGraphReady()
  const windowId = runtime.getAuthoritativeWindowId(NO_WORKSPACE_OR_WINDOW_MESSAGE)
  const response = await getRuntimeDesktopSurface().requestRenderer<{
    requestId: string
    tabId?: string
    title?: string
    error?: string
  }>(windowId, {
    channel: 'terminal:requestTabCreate',
    replyChannel: 'terminal:tabCreateReply',
    timeoutMs: 10000,
    timeoutMessage: 'Terminal creation timed out',
    payload: {
      command: opts.command,
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
      ...(opts.resumeProviderSession ? { resumeProviderSession: opts.resumeProviderSession } : {}),
      ...(opts.launchToken ? { launchToken: opts.launchToken } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      ...(opts.trustWorktreeId ? { trustWorktreeId: opts.trustWorktreeId } : {}),
      ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
      startupCommandDelivery: opts.startupCommandDelivery,
      title: opts.title,
      activate: presentation === 'focused',
      ...(presentation ? { presentation } : {}),
      ...ownerSurfacing(opts.surfaceOwner !== false)
    }
  })
  if (response.error) {
    throw new Error(response.error)
  }
  const reply = { tabId: response.tabId!, title: response.title ?? opts.title ?? '' }
  const handle = await runtime.waitForTerminalHandle(reply.tabId)
  return {
    handle,
    tabId: reply.tabId,
    worktreeId: '',
    title: reply.title,
    ...runtime.getPtyExecutionHostMetadata(runtime.handles.get(handle)?.ptyId ?? null),
    surface: 'visible'
  }
}
