import { toRuntimeExecutionHostId } from '../shared/execution-host'
import type { RuntimeTerminalShow } from '../shared/runtime-types'
import type { RuntimeTerminalReveal } from '../shared/terminal-pane-reveal'
import { RuntimeClient } from './runtime-client'
import { resolveEnvironment } from './runtime/environments'

// Just past the desktop's 10 s renderer wait. Bounds every step before the host fallback: the paired
// host's terminal.show (a cold worktree catalog can scan) and the whole local client, probe included.
const LOCAL_DESKTOP_REVEAL_TIMEOUT_MS = 12_000

/** Reveal a paired environment's pane on this machine's desktop, the window the CLI user sees. */
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
      await client.call<{ terminal: RuntimeTerminalShow }>(
        'terminal.show',
        { terminal: handle },
        { timeoutMs: LOCAL_DESKTOP_REVEAL_TIMEOUT_MS }
      )
    ).result
    const desktop = new RuntimeClient(
      client.userDataPath,
      LOCAL_DESKTOP_REVEAL_TIMEOUT_MS,
      null,
      null
    )
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
