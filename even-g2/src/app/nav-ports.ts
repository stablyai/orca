// Integrator wiring (Unit 8, spec S10 step 5): the concrete NavPorts HudInputRouter drives its
// effects through, wired to real bridge/transport/session state.
//
// Integrator note (review findings #1/#3, cross-cluster seam): a failed/unresolved
// sendAskAnswer only logs to console today because HudState (src/state/hud-store.ts) has no
// slice for it and ask-screen.ts's footer only reads `askAnswered`. To surface this on the
// glasses, add a small error slice (e.g. `askSendError: { worktreeId, message } | null`) that
// ask-screen.ts's footer renders, cleared the next time this worktree's ask is answered or a
// new ask arrives for it.
import type { GlassesBridge } from '../glasses/glasses-bridge'
import type { HudRenderQueue } from '../hud/hud-render-queue'
import { topFrame } from '../navigation/hud-navigation-frames'
import type { NavPorts } from '../navigation/hud-input-router'
import type { RpcResponse, RpcSuccess } from '../transport/orca-rpc-wire'
import type { HudState, HudStore } from '../state/hud-store'
import { resolveActiveTerminalHandle } from './agent-terminal-resolution'
import type { HostSessionManager } from './host-session-manager'
import { patchTerminalTailFrameId } from './terminal-tail-frame-patch'

export type NavPortsDeps = {
  bridge: GlassesBridge
  store: HudStore
  sessions: HostSessionManager
  renderQueue: HudRenderQueue
  submitRender(state: HudState): void
  setForeground(foreground: boolean): void
}

type TerminalSendResult = { send?: { accepted?: boolean; bytesWritten?: number } }

// Bumped on every openTerminalTail/closeTerminalTail call so an in-flight resolveActive
// round-trip from a superseded call can recognize itself as stale (finding #8) and skip
// subscribing instead of racing a later open/close.
let terminalTailGeneration = 0

function isTerminalTailFrameActive(store: HudStore, worktreeId: string): boolean {
  const frame = topFrame(store.getState().nav)
  return frame.screen === 'terminalTail' && frame.worktreeId === worktreeId
}

async function openTerminalTail(deps: NavPortsDeps, worktreeId: string): Promise<void> {
  const generation = ++terminalTailGeneration
  const session = deps.sessions.current()
  if (!session) {
    return
  }
  const terminalId = await resolveActiveTerminalHandle(session.client, worktreeId)
  // Stale if superseded by a later open()/close() call, the active host session changed while
  // resolving, or the user navigated off this terminal-tail frame in the meantime (finding #8)
  // — in every case, never establish the subscription.
  if (
    generation !== terminalTailGeneration ||
    deps.sessions.current() !== session ||
    !isTerminalTailFrameActive(deps.store, worktreeId)
  ) {
    return
  }
  if (!terminalId) {
    return
  }
  session.terminalTail.open(terminalId)
  patchTerminalTailFrameId(deps.store, worktreeId, terminalId)
}

function isSendAccepted(response: RpcResponse): boolean {
  if (!response.ok) {
    return false
  }
  const result = (response as RpcSuccess).result as TerminalSendResult
  return result.send?.accepted === true
}

// Resolves the worktree's authoritative active terminal and sends the quick-action keys in one
// terminal.send call (spec S7/R5) — v1 never labels options with semantics it can't verify, and
// never splits the keys into separate body/Enter sends.
async function sendAskAnswer(
  deps: NavPortsDeps,
  hostId: string,
  worktreeId: string,
  keys: string
): Promise<void> {
  const session = deps.sessions.current()
  // Host-boundary guard (finding #2): never resolve or send through a session for a different
  // host than the effect targets — a stale ask surviving a host switch must not reach host B.
  if (!session || session.hostId !== hostId) {
    return
  }
  const terminalId = await resolveActiveTerminalHandle(session.client, worktreeId)
  if (deps.sessions.current() !== session) {
    return // host switched while resolving
  }
  if (!terminalId) {
    // Fail closed (finding #1): no host-proven unique active terminal — never guess.
    console.error(`[orca-g2] couldn't resolve an active terminal for worktree ${worktreeId}`)
    return
  }
  const response = await session.client.sendRequest('terminal.send', {
    terminal: terminalId,
    text: keys
  })
  if (deps.sessions.current() !== session) {
    return // host switched while sending
  }
  if (!isSendAccepted(response)) {
    // Rejected send (finding #3): keep the ask actionable rather than optimistically marking
    // it answered — the caller can retry. (See file-level integrator note on surfacing this.)
    console.error(`[orca-g2] terminal.send was not accepted for worktree ${worktreeId}`)
    return
  }
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
      terminalTailGeneration++ // invalidate any in-flight openTerminalTail resolution
      deps.sessions.current()?.terminalTail.close()
    },
    sendAskAnswer(hostId: string, worktreeId: string, keys: string): void {
      void sendAskAnswer(deps, hostId, worktreeId, keys)
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
    },
    invalidateRender(): void {
      // The exit dialog blanked the firmware page; drop the render queue's memory of the last
      // page so the next submit is a full rebuild (not a differ noop), then re-render now
      // (finding hud-navigation.ts:264 — cancelling the dialog must un-blank the HUD).
      deps.renderQueue.invalidate()
      deps.submitRender(deps.store.getState())
    },
    reopenTerminalTail(worktreeId: string): void {
      void openTerminalTail(deps, worktreeId)
    }
  }
}
