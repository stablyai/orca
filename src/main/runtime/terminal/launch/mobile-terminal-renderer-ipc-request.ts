import { randomUUID } from 'node:crypto'
import type { IpcMainEvent } from 'electron'
import { getRuntimeDesktopSurface } from '../../runtime-desktop-surface'
import type { MobileTerminalCommand } from './mobile-terminal-startup'
import type { AgentProviderSessionMetadata } from '../../../../shared/agent-session-resume'

export function requestMobileRendererTerminalTabCreate(args: {
  win: { webContents: { send(channel: string, payload: unknown): void } }
  worktreeId: string
  afterDesktopTabId?: string
  targetGroupId?: string
  shellOverride?: string
  cwd?: string
  effectiveTitle?: string
  startupCommand: MobileTerminalCommand
  resumeProviderSession?: AgentProviderSessionMetadata
  viewMode?: 'terminal' | 'chat'
  activate?: boolean
  signal?: AbortSignal
}): Promise<{ tabId: string; title: string }> {
  const { win } = args
  const requestId = randomUUID()
  return new Promise<{ tabId: string; title: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
      args.signal?.removeEventListener('abort', onAbort)
      reject(new Error('Terminal creation timed out'))
    }, 10_000)
    // Why: a dead client connection cancels the wait; the renderer tab (and
    // its shell) stays alive for the host and mirrors on reconnect (#7718).
    const onAbort = (): void => {
      clearTimeout(timer)
      getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
      reject(new Error('client_disconnected'))
    }

    const handler = (
      event: IpcMainEvent,
      r: { requestId: string; tabId?: string; title?: string; error?: string }
    ): void => {
      if (event.sender !== win.webContents || r.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      getRuntimeDesktopSurface().removeIpcListener('terminal:tabCreateReply', handler)
      args.signal?.removeEventListener('abort', onAbort)
      if (r.error) {
        reject(new Error(r.error))
      } else {
        resolve({ tabId: r.tabId!, title: r.title ?? '' })
      }
    }
    args.signal?.addEventListener('abort', onAbort, { once: true })
    getRuntimeDesktopSurface().onIpc('terminal:tabCreateReply', handler)
    win.webContents.send('terminal:requestTabCreate', {
      requestId,
      worktreeId: args.worktreeId,
      afterTabId: args.afterDesktopTabId,
      targetGroupId: args.targetGroupId,
      command: args.startupCommand.command,
      ...(args.shellOverride ? { shellOverride: args.shellOverride } : {}),
      cwd: args.cwd,
      ...(args.effectiveTitle ? { title: args.effectiveTitle } : {}),
      ...(args.startupCommand.env ? { env: args.startupCommand.env } : {}),
      ...(args.startupCommand.envToDelete ? { envToDelete: args.startupCommand.envToDelete } : {}),
      ...(args.startupCommand.launchConfig
        ? { launchConfig: args.startupCommand.launchConfig }
        : {}),
      ...(args.resumeProviderSession ? { resumeProviderSession: args.resumeProviderSession } : {}),
      ...(args.startupCommand.launchAgent ? { launchAgent: args.startupCommand.launchAgent } : {}),
      ...(args.viewMode ? { viewMode: args.viewMode } : {}),
      startupCommandDelivery: args.startupCommand.startupCommandDelivery,
      source: 'runtime-session',
      activate: args.activate
    })
  })
}
