import { app } from 'electron'
import { z } from 'zod'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { isRuntimeEnvironmentManuallyDisconnected } from '../ipc/runtime-environments/runtime-environment-manual-disconnect'
import { mainProcessState as state } from './main-process-state'
import type { TerminalDeepLinkHost } from './terminal-deep-link-state'

// Only the pane a link reveals is read from the paired server's answer.
const TerminalShowSchema = z.object({
  terminal: z.object({ worktreeId: z.string(), tabId: z.string(), leafId: z.string() })
})

/** Null until a desktop window exists, so a sidecar hands links on and a headless serve ignores them. */
export function getTerminalDeepLinkHost(): TerminalDeepLinkHost | null {
  const runtime = state.runtime
  const window = state.mainWindow
  if (!runtime || !window || window.isDestroyed()) {
    return null
  }
  const userDataPath = app.getPath('userData')
  return {
    isWindowGraphReady: () => runtime.getStatus().graphStatus === 'ready',
    runtime,
    resolveEnvironmentId: (selector) => resolveEnvironment(userDataPath, selector).id,
    showEnvironmentTerminal: async (environmentId, handle) => {
      // A link must not reconnect a server the user disconnected.
      if (isRuntimeEnvironmentManuallyDisconnected(environmentId)) {
        throw new Error('environment_disconnected')
      }
      const response = await callRuntimeEnvironment(userDataPath, environmentId, 'terminal.show', {
        terminal: handle
      })
      if (!response.ok) {
        throw new Error(response.error.code)
      }
      return TerminalShowSchema.parse(response.result).terminal
    }
  }
}
