import { applyClaudeTerminalImageViewerEnv } from './terminal-image-viewer-env'
import * as dependencies from './orca-runtime-create-terminal-dependencies'
import type { OrcaRuntimeWithCreateTerminal } from './terminal/launch/terminal-create'
import type { RuntimeTerminalPresentation } from '../../shared/runtime-types'

// A create with no workspace lands in whatever the window is showing, so only the window can make it.
export async function createDesktopTerminal(
  runtime: OrcaRuntimeWithCreateTerminal,
  opts: dependencies.TerminalCreateOptions,
  presentation: RuntimeTerminalPresentation | undefined
): Promise<dependencies.RuntimeTerminalCreate> {
  // A worktree-less create has no execution host to resolve the shell on.
  if (opts.shellOverride) {
    throw new Error(
      `--shell ${opts.shellOverride} needs a workspace, because the shell is resolved on the workspace's execution host. No terminal was created.`
    )
  }
  opts = applyClaudeTerminalImageViewerEnv(opts, opts.terminalImageViewerSupported)
  runtime.assertGraphReady()
  const win = runtime.getAuthoritativeWindow()
  const requestId = dependencies.randomUUID()
  const reply = await new Promise<{ tabId: string; title: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      dependencies.getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
      reject(new Error('Terminal creation timed out'))
    }, 10000)
    const handler = (
      event: dependencies.IpcMainEvent,
      response: {
        requestId: string
        tabId?: string
        title?: string
        error?: string
      }
    ): void => {
      if (event.sender !== win.webContents || response.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      dependencies.getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
      if (response.error) {
        reject(new Error(response.error))
      } else {
        resolve({ tabId: response.tabId!, title: response.title ?? opts.title ?? '' })
      }
    }
    dependencies.getRuntimeDesktopSurface().onIpc('terminal:tabCreateReply', handler)
    win.webContents.send('terminal:requestTabCreate', {
      requestId,
      command: opts.command,
      cwd: opts.cwd,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.launchConfig ? { launchConfig: opts.launchConfig } : {}),
      ...(opts.resumeProviderSession ? { resumeProviderSession: opts.resumeProviderSession } : {}),
      ...(opts.launchToken ? { launchToken: opts.launchToken } : {}),
      ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {}),
      ...(opts.viewMode ? { viewMode: opts.viewMode } : {}),
      startupCommandDelivery: opts.startupCommandDelivery,
      title: opts.title,
      activate: presentation === 'focused',
      ...(presentation ? { presentation } : {}),
      ...dependencies.ownerSurfacing(opts.surfaceOwner !== false)
    })
  })
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
