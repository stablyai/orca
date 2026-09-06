// Integrator wiring (Unit 8, spec S10 step 5): the concrete NavPorts HudInputRouter drives its
// effects through, wired to real bridge/transport/session state.
//
// CRITICAL #10/#11, HIGH #2/#3/#6: sendAskAnswer resolves the worktree's unique waiting terminal
// (never desktop focus), re-validates the exact prompt (notificationId) it was asked to answer
// both before and after that async resolution, latches against double-sends via
// HudState.askInteraction (scoped by host + notificationId; see ask-interaction-tracking.ts),
// and drives that same slice through 'sending' -> 'checking' -> 'answered'/'stalled'/'failed'/
// 'unresolved' so ask-screen.ts's footer can render the real outcome instead of only ever an
// optimistic "answered".
import type { GlassesBridge } from '../glasses/glasses-bridge'
import type { HudRenderQueue } from '../hud/hud-render-queue'
import { topFrame } from '../navigation/hud-navigation-frames'
import type { NavPorts } from '../navigation/hud-input-router'
import type { RpcResponse, RpcSuccess } from '../transport/orca-rpc-wire'
import type { HudState, HudStore } from '../state/hud-store'
import {
  ASK_RETRY_BLOCKED_PHASES,
  CONFIRMATION_POLL_DEADLINE_MS,
  isAskStillLive,
  ownsAskInteraction,
  reconcileStalledAskInteraction,
  REAL_TIMER,
  scheduleConfirmationPoll,
  setAskPhase,
  type NavPortsTimer
} from './ask-interaction-tracking'
import {
  resolveActiveTerminalHandle,
  resolveWaitingTerminalHandle
} from './agent-terminal-resolution'
import type { HostSessionManager } from './host-session-manager'
import { patchTerminalTailFrameId } from './terminal-tail-frame-patch'

export type { NavPortsTimer } from './ask-interaction-tracking'

export type NavPortsDeps = {
  bridge: GlassesBridge
  store: HudStore
  sessions: HostSessionManager
  renderQueue: HudRenderQueue
  submitRender(state: HudState): void
  setForeground(foreground: boolean): void
  timer?: NavPortsTimer
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

/**
 * Resolves the worktree's unique waiting terminal (CRITICAL #10 — never terminal.resolveActive,
 * which tracks desktop focus, not who asked) and sends the quick-action keys in one
 * terminal.send call. Re-validates the exact prompt (HIGH #2) both before sending and again
 * after the async resolution, latches against concurrent/duplicate sends for that SAME prompt
 * (CRITICAL #11, HIGH #3), and drives askInteraction through its phases (HIGH #3/#6, see
 * ask-interaction-tracking.ts) so the ask screen can show what actually happened instead of only
 * ever an optimistic "answered".
 */
async function sendAskAnswer(
  deps: NavPortsDeps,
  hostId: string,
  worktreeId: string,
  notificationId: string,
  keys: string
): Promise<void> {
  const session = deps.sessions.current()
  // Host-boundary guard (finding #2): never resolve or send through a session for a different
  // host than the effect targets — a stale ask surviving a host switch must not reach host B,
  // and must not touch this host's askInteraction either.
  if (!session || session.hostId !== hostId) {
    return
  }

  const state = deps.store.getState()

  // Latch (CRITICAL #11/HIGH #3): defensive re-check — the reducer already screens repeat clicks
  // via NavContext.askSendInFlight, but effects are a queue, not a call stack, so re-verify here
  // too. Scoped to the SAME host + notificationId: a different prompt is never blocked by this.
  const existing = state.askInteraction
  if (
    existing &&
    existing.hostId === hostId &&
    existing.notificationId === notificationId &&
    ASK_RETRY_BLOCKED_PHASES.has(existing.phase)
  ) {
    return
  }

  // Re-validate against the freshest state (CRITICAL #11/HIGH #2): the ask may have expired
  // (answered from the phone, superseded by a newer prompt, or the agent moved on) between the
  // click and this call landing.
  if (!isAskStillLive(state, hostId, worktreeId, notificationId)) {
    setAskPhase(deps.store, hostId, notificationId, worktreeId, 'failed')
    return
  }

  setAskPhase(deps.store, hostId, notificationId, worktreeId, 'sending')

  let resolution: Awaited<ReturnType<typeof resolveWaitingTerminalHandle>>
  try {
    resolution = await resolveWaitingTerminalHandle(session.client, worktreeId)
  } catch {
    // HIGH #2/#3: never swallow, but never stomp a newer prompt/host that has since claimed the
    // interaction slot either.
    if (
      deps.sessions.current() === session &&
      ownsAskInteraction(deps.store.getState(), hostId, notificationId)
    ) {
      setAskPhase(deps.store, hostId, notificationId, worktreeId, 'unresolved')
    }
    return
  }
  if (deps.sessions.current() !== session) {
    return // host switched while resolving — the new session's own effects own this now
  }
  // Re-validate again (HIGH #2): the prompt the wearer saw may be gone by the time resolution
  // landed — abort rather than send to whatever terminal is waiting NOW for a DIFFERENT ask.
  if (!isAskStillLive(deps.store.getState(), hostId, worktreeId, notificationId)) {
    return
  }
  if (!('handle' in resolution)) {
    // Fail closed (CRITICAL #10): zero or more than one terminal needs input — never guess.
    setAskPhase(deps.store, hostId, notificationId, worktreeId, 'failed')
    return
  }

  let response: RpcResponse
  try {
    response = await session.client.sendRequest('terminal.send', {
      terminal: resolution.handle,
      text: keys
    })
  } catch {
    if (
      deps.sessions.current() === session &&
      ownsAskInteraction(deps.store.getState(), hostId, notificationId)
    ) {
      setAskPhase(deps.store, hostId, notificationId, worktreeId, 'unresolved') // HIGH #2/#3
    }
    return
  }
  if (deps.sessions.current() !== session) {
    return
  }
  if (!ownsAskInteraction(deps.store.getState(), hostId, notificationId)) {
    return // a newer prompt/host already claimed the slot while terminal.send was in flight
  }
  if (!isSendAccepted(response)) {
    // Rejected send (HIGH #3): keep the ask actionable — the footer offers a retry.
    setAskPhase(deps.store, hostId, notificationId, worktreeId, 'failed')
    return
  }

  setAskPhase(deps.store, hostId, notificationId, worktreeId, 'checking')
  session.dashboard.refreshNow()
  scheduleConfirmationPoll(
    deps,
    session,
    hostId,
    notificationId,
    worktreeId,
    (deps.timer ?? REAL_TIMER).now() + CONFIRMATION_POLL_DEADLINE_MS
  )
}

export function createNavPorts(deps: NavPortsDeps): NavPorts {
  // HIGH #6: reconcile a 'stalled' ask on every subsequent store update — see
  // reconcileStalledAskInteraction's doc comment.
  deps.store.subscribe(() => reconcileStalledAskInteraction(deps.store))

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
    sendAskAnswer(hostId: string, worktreeId: string, notificationId: string, keys: string): void {
      void sendAskAnswer(deps, hostId, worktreeId, notificationId, keys)
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
