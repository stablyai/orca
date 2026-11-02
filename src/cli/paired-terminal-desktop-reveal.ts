import { toRuntimeExecutionHostId } from '../shared/execution-host'
import type { RuntimeTerminalShow } from '../shared/runtime-types'
import type { RuntimeTerminalReveal } from '../shared/terminal-pane-reveal'
import { RuntimeClient } from './runtime-client'
import { resolveEnvironment } from './runtime/environments'

/** Paired servers have no window; reveal their pane through a local desktop if one is available. */
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
    return false
  }
}
