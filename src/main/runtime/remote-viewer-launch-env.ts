import type { TuiAgent } from '../../shared/tui-agent'
import { applyRemoteViewerClipboardEnv } from '../ipc/pty/host-env/remote-viewer-clipboard-env'
import { applyClaudeTerminalImageViewerEnv } from './terminal-image-viewer-env'

/** Undefined viewer support means a host-local window/CLI launch; either boolean identifies a remote caller. */
export function applyRemoteViewerLaunchEnv<
  T extends {
    launchAgent?: TuiAgent
    env?: Record<string, string>
  }
>(launch: T, terminalImageViewerSupported: boolean | undefined, agent = launch.launchAgent): T {
  const next = applyClaudeTerminalImageViewerEnv(launch, terminalImageViewerSupported, agent)
  if (terminalImageViewerSupported === undefined) {
    return next
  }
  // Desktop hosts lack headless env; mark remote caller viewer capability explicitly (#10861).
  const env = { ...next.env }
  applyRemoteViewerClipboardEnv(env, { launchAgent: agent, viewerIsRemote: true })
  return { ...next, env }
}
