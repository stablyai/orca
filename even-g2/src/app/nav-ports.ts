// Integrator wiring (Unit 8, spec S10 step 5): the concrete NavPorts HudInputRouter drives its
// effects through, wired to real bridge/transport/session state.
import type { GlassesBridge } from '../glasses/glasses-bridge'
import type { NavPorts } from '../navigation/hud-input-router'
import type { HudStore } from '../state/hud-store'
import { resolveAgentTerminalId } from './agent-terminal-resolution'
import type { HostSessionManager } from './host-session-manager'
import { patchTerminalTailFrameId } from './terminal-tail-frame-patch'

export type NavPortsDeps = {
  bridge: GlassesBridge
  store: HudStore
  sessions: HostSessionManager
  setForeground(foreground: boolean): void
}

async function openTerminalTail(deps: NavPortsDeps, worktreeId: string): Promise<void> {
  const session = deps.sessions.current()
  if (!session) {
    return
  }
  const terminalId = await resolveAgentTerminalId(session.client, worktreeId)
  if (!terminalId) {
    return
  }
  session.terminalTail.open(terminalId)
  patchTerminalTailFrameId(deps.store, worktreeId, terminalId)
}

// Resolves the worktree's live agent terminal and sends the quick-action keys in one
// terminal.send call (spec S7/R5) — v1 never labels options with semantics it can't verify, and
// never splits the keys into separate body/Enter sends.
async function sendAskAnswer(deps: NavPortsDeps, worktreeId: string, keys: string): Promise<void> {
  const session = deps.sessions.current()
  if (!session) {
    return
  }
  const terminalId = await resolveAgentTerminalId(session.client, worktreeId)
  if (!terminalId) {
    return
  }
  await session.client.sendRequest('terminal.send', { terminal: terminalId, text: keys })
  deps.store.update((s) => ({ ...s, askAnswered: { worktreeId, sentAt: Date.now() } }))
}

export function createNavPorts(deps: NavPortsDeps): NavPorts {
  return {
    shutdownDialog(): void {
      void deps.bridge.shutDownPage(1)
    },
    connectHost(hostId: string): void {
      void deps.sessions.connect(hostId)
    },
    openTerminalTail(worktreeId: string): void {
      void openTerminalTail(deps, worktreeId)
    },
    closeTerminalTail(): void {
      deps.sessions.current()?.terminalTail.close()
    },
    sendAskAnswer(_hostId: string, worktreeId: string, keys: string): void {
      void sendAskAnswer(deps, worktreeId, keys)
    },
    refreshDashboard(): void {
      deps.sessions.current()?.dashboard.refreshNow()
    },
    pausePolling(): void {
      deps.setForeground(false)
    },
    resumePolling(): void {
      deps.setForeground(true)
      deps.sessions.current()?.dashboard.refreshNow()
    },
    disconnectHost(): void {
      deps.sessions.close()
    }
  }
}
