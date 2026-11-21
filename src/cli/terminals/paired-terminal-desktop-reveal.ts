import { toRuntimeExecutionHostId } from '../../shared/execution-host/execution-host'
import type { RuntimeTerminalShow } from '../../shared/terminal/runtime/runtime-terminal-contracts'
import type { RuntimeTerminalReveal } from '../../shared/workspace-layout/terminal-surfaces/terminal-pane-reveal'
import { RuntimeClient } from '../runtime/client'
import { resolveEnvironment } from '../runtime/pairing/environments'

type PairedPane = { worktreeId: string; tabId: string; leafId: string | null }

/** Paired servers have no window; reveal their pane through a local desktop if one is available. */
export async function revealPairedTerminalOnLocalDesktop(
  client: RuntimeClient,
  handle: string
): Promise<boolean> {
  return revealPairedPaneOnLocalDesktop(client, async () => {
    const { terminal } = (
      await client.call<{ terminal: RuntimeTerminalShow }>('terminal.show', { terminal: handle })
    ).result
    return terminal
  })
}

export async function revealPairedPaneOnLocalDesktop(
  client: RuntimeClient,
  pane: () => Promise<PairedPane>
): Promise<boolean> {
  if (!client.environmentSelector) {
    return false
  }
  try {
    const environment = await resolveEnvironment(client.userDataPath, client.environmentSelector)
    const { worktreeId, tabId, leafId } = await pane()
    const desktop = new RuntimeClient(client.userDataPath, undefined, null, null)
    const revealed = await desktop.call<{ reveal: RuntimeTerminalReveal }>('terminal.reveal', {
      worktreeId,
      tabId,
      leafId,
      executionHostId: toRuntimeExecutionHostId(environment.id)
    })
    return revealed.result.reveal.navigated
  } catch {
    return false
  }
}
