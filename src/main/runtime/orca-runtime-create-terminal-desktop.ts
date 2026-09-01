// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import * as dependencies from './orca-runtime-create-terminal-dependencies'
import type { OrcaRuntimeWithCreateTerminal } from './orca-runtime-create-terminal'
import type { RuntimeTerminalPresentation } from '../../shared/runtime-types'

export async function createDesktopTerminal(
  runtime: OrcaRuntimeWithCreateTerminal,
  worktreeSelector: string | undefined,
  opts: dependencies.TerminalCreateOptions,
  presentation: RuntimeTerminalPresentation | undefined,
  rendererWindow: Electron.BrowserWindow | null
): Promise<dependencies.RuntimeTerminalCreate> {
  runtime.assertGraphReady()
  const win = rendererWindow ?? runtime.getAuthoritativeWindow()
  const workspace = worktreeSelector
    ? await runtime.resolveTerminalWorkspaceLaunchScope(worktreeSelector)
    : null
  const launchOpts = workspace
    ? await runtime.resolveAgentTerminalCreateOptions(workspace, opts)
    : opts
  const worktreeId = workspace?.id
  const cwd = workspace
    ? runtime.resolveWorkspaceTerminalStartupCwd(workspace, launchOpts.cwd)
    : launchOpts.cwd
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
        resolve({ tabId: response.tabId!, title: response.title ?? launchOpts.title ?? '' })
      }
    }
    dependencies.getRuntimeDesktopSurface().onIpc('terminal:tabCreateReply', handler)
    win.webContents.send('terminal:requestTabCreate', {
      requestId,
      worktreeId,
      command: launchOpts.command,
      cwd,
      ...(launchOpts.env ? { env: launchOpts.env } : {}),
      ...(launchOpts.launchConfig ? { launchConfig: launchOpts.launchConfig } : {}),
      ...(launchOpts.resumeProviderSession
        ? { resumeProviderSession: launchOpts.resumeProviderSession }
        : {}),
      ...(launchOpts.launchToken ? { launchToken: launchOpts.launchToken } : {}),
      ...(launchOpts.launchAgent ? { launchAgent: launchOpts.launchAgent } : {}),
      ...(launchOpts.viewMode ? { viewMode: launchOpts.viewMode } : {}),
      startupCommandDelivery: launchOpts.startupCommandDelivery,
      title: launchOpts.title,
      activate: presentation === 'focused',
      ...(presentation ? { presentation } : {}),
      ...dependencies.ownerSurfacing(opts.surfaceOwner !== false)
    })
  })
  const handle = await runtime.waitForTerminalHandle(reply.tabId)
  return {
    handle,
    tabId: reply.tabId,
    worktreeId: worktreeId ?? '',
    title: reply.title,
    ...runtime.getPtyExecutionHostMetadata(runtime.handles.get(handle)?.ptyId ?? null),
    surface: 'visible'
  }
}
