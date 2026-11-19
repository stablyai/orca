import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { ORCA_TERMINAL_IMAGE_VIEWER_ENV } from '../../../../shared/terminal/images/terminal-image-protocol'
import { applyRemoteViewerClipboardEnv } from '../../../ipc/pty/host-env/remote-viewer-clipboard-env'

/** Undefined viewer support means a host-local window/CLI launch; either boolean identifies a remote caller. */
export function applyRemoteViewerLaunchEnv<
  T extends {
    launchAgent?: TuiAgent
    env?: Record<string, string>
  }
>(launch: T, terminalImageViewerSupported: boolean | undefined, agent = launch.launchAgent): T {
  if (terminalImageViewerSupported === undefined) {
    return launch
  }
  // Desktop hosts lack headless env; mark remote caller viewer capability explicitly (#10861).
  const env = {
    ...launch.env,
    [ORCA_TERMINAL_IMAGE_VIEWER_ENV]: terminalImageViewerSupported ? '1' : '0'
  }
  applyRemoteViewerClipboardEnv(env, { launchAgent: agent, viewerIsRemote: true })
  return { ...launch, env }
}
