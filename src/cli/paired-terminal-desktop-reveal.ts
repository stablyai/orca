import { toRuntimeExecutionHostId } from '../shared/execution-host'
import type { RuntimeTerminalShow } from '../shared/runtime-types'
import type { RuntimeTerminalReveal } from '../shared/terminal-pane-reveal'
import { RuntimeClient } from './runtime-client'
import { resolveEnvironment } from './runtime/environments'

/**
 * A paired server has no window, so `terminal.focus` there never navigates (#24688). The desktop
 * app on this machine shows that server's panes under the same ids and can reveal one.
 * Resolves false when no local desktop shows the environment; the server's answer then stands.
 */
export async function revealPairedTerminalOnLocalDesktop(
  client: RuntimeClient,
  handle: string
): Promise<boolean> {
  if (!client.environmentSelector) {
    return false
  }
  try {
    const environment = resolveEnvironment(client.userDataPath, client.environmentSelector)
    const { terminal } = (
      await client.call<{ terminal: RuntimeTerminalShow }>('terminal.show', { terminal: handle })
    ).result
    const desktop = new RuntimeClient(client.userDataPath, undefined, null, null)
    const revealed = await desktop.call<{ reveal: RuntimeTerminalReveal }>('terminal.reveal', {
      worktreeId: terminal.worktreeId,
      tabId: terminal.tabId,
      leafId: terminal.leafId,
      executionHostId: toRuntimeExecutionHostId(environment.id)
    })
    return revealed.result.reveal.navigated
  } catch {
    // Why: no desktop here, one without terminal.reveal, a headless one, or a handle gone since.
    return false
  }
}
