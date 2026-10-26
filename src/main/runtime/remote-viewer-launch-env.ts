import type { TuiAgent } from '../../shared/tui-agent'
import { applyCodexRemoteViewerClipboardEnv } from '../ipc/pty/host-env/codex-terminal-clipboard'
import { applyClaudeTerminalImageViewerEnv } from './terminal-image-viewer-env'

/** Undefined viewer support means a host-local window/CLI launch; either boolean identifies a remote caller. */
export function applyRemoteViewerLaunchEnv<
  T extends {
    launchAgent?: TuiAgent
    env?: Record<string, string>
  }
>(launch: T, terminalImageViewerSupported: boolean | undefined, agent = launch.launchAgent): T {
  const next = applyClaudeTerminalImageViewerEnv(launch, terminalImageViewerSupported, agent)
  if (terminalImageViewerSupported === undefined || agent !== 'codex') {
    return next
  }
  // Desktop hosts lack headless env; mark remote caller viewer capability explicitly (#10861).
  const env = { ...next.env }
  applyCodexRemoteViewerClipboardEnv(env, { launchAgent: agent, viewerIsRemote: true })
  return env.SSH_CONNECTION === next.env?.SSH_CONNECTION ? next : { ...next, env }
}
