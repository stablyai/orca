// Integrator wiring (Unit 8, spec S10 step 5): the concrete NavPorts HudInputRouter drives its
// effects through, wired to real bridge/transport/session state.
//
// CRITICAL #10/#11, HIGH #2/#3/#12: sendAskAnswer resolves the worktree's unique waiting
// terminal (never desktop focus), latches against double-sends via HudState.askInteraction, and
// drives that same slice through 'sending' -> 'checking' -> 'answered'/'unresolved' so
// ask-screen.ts's footer can render the real outcome instead of only ever an optimistic
// "answered".
import type { GlassesBridge } from '../glasses/glasses-bridge'
import type { HudRenderQueue } from '../hud/hud-render-queue'
import { topFrame } from '../navigation/hud-navigation-frames'
import type { NavPorts } from '../navigation/hud-input-router'
import type { RpcResponse, RpcSuccess } from '../transport/orca-rpc-wire'
import type { AskInteraction, HudState, HudStore } from '../state/hud-store'
import { currentAsk } from '../state/notification-inbox-state'
import {
  resolveActiveTerminalHandle,
  resolveWaitingTerminalHandle
} from './agent-terminal-resolution'
import type { ActiveHostSession, HostSessionManager } from './host-session-manager'
import { patchTerminalTailFrameId } from './terminal-tail-frame-patch'

/** Injectable so tests can drive the bounded confirmation poll (finding #12) deterministically. */
export type NavPortsTimer = {
  setTimeout(cb: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_TIMER: NavPortsTimer = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

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

type AskPhase = NonNullable<AskInteraction>['phase']

function setAskPhase(
  store: HudStore,
  notificationId: string,
  worktreeId: string,
  phase: AskPhase
): void {
  store.update((s) => ({
    ...s,
    askInteraction: { notificationId, worktreeId, phase, updatedAt: Date.now() }
  }))
}

/** currentAsk() is the ground truth for "which notification is this ask" (finding #13); a
 *  worktreeId with no matching current ask (already answered/expired) still gets a stable id
 *  of its own so the interaction can be tracked/rendered. */
function resolveAskNotificationId(state: HudState, worktreeId: string): string {
  const ask = currentAsk(state)
  return ask && ask.worktreeId === worktreeId ? ask.notificationId : worktreeId
}

const BLOCKED_RETRY_PHASES: ReadonlySet<AskPhase> = new Set(['sending', 'checking', 'unresolved'])

// Bounded confirmation poll (HIGH #12): after an accepted send, refresh worktree.ps a few times
// over roughly a second to observe whether the worktree actually left `permission`, rather than
// leaving the footer optimistically "answered" forever on nothing but the RPC accept.
const CONFIRMATION_POLL_INTERVALS_MS = [300, 300, 300]

function scheduleConfirmationPoll(
  deps: NavPortsDeps,
  session: ActiveHostSession,
  notificationId: string,
  worktreeId: string,
  attemptsLeft: number = CONFIRMATION_POLL_INTERVALS_MS.length
): void {
  const timer = deps.timer ?? REAL_TIMER
  const delay =
    CONFIRMATION_POLL_INTERVALS_MS[CONFIRMATION_POLL_INTERVALS_MS.length - attemptsLeft]!
  timer.setTimeout(() => {
    if (deps.sessions.current() !== session) {
      return // host switched mid-poll — a fresher session (if any) owns this worktree's state
    }
    const interaction = deps.store.getState().askInteraction
    if (
      !interaction ||
      interaction.notificationId !== notificationId ||
      interaction.phase !== 'checking'
    ) {
      return // superseded: answered another way, a new send started, or the wearer moved on
    }
    const row = deps.store.getState().dashboard.rows.find((r) => r.worktreeId === worktreeId)
    if (row === undefined || row.status !== 'permission') {
      setAskPhase(deps.store, notificationId, worktreeId, 'answered')
      return
    }
    if (attemptsLeft <= 1) {
      // Bounded attempts exhausted, still `permission`: sent, but delivery/consumption can't be
      // confirmed from here — honest rather than optimistic.
      setAskPhase(deps.store, notificationId, worktreeId, 'unresolved')
      return
    }
    session.dashboard.refreshNow()
    scheduleConfirmationPoll(deps, session, notificationId, worktreeId, attemptsLeft - 1)
  }, delay)
}

/**
 * Resolves the worktree's unique waiting terminal (CRITICAL #10 — never terminal.resolveActive,
 * which tracks desktop focus, not who asked) and sends the quick-action keys in one
 * terminal.send call. Latches against concurrent/duplicate sends and drives askInteraction
 * through its phases (CRITICAL #11, HIGH #2/#3/#12) so the ask screen can show what actually
 * happened instead of only ever an optimistic "answered".
 */
async function sendAskAnswer(
  deps: NavPortsDeps,
  hostId: string,
  worktreeId: string,
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
  const notificationId = resolveAskNotificationId(state, worktreeId)

  // Latch (CRITICAL #11): defensive re-check — the reducer already screens repeat clicks via
  // NavContext.askSendInFlight, but effects are a queue, not a call stack, so re-verify here too.
  const existing = state.askInteraction
  if (existing && existing.worktreeId === worktreeId && BLOCKED_RETRY_PHASES.has(existing.phase)) {
    return
  }

  // Re-validate against the freshest dashboard snapshot (CRITICAL #11): the ask may have expired
  // (answered from the phone, or the agent moved on) between the click and this call landing.
  const row = state.dashboard.rows.find((r) => r.worktreeId === worktreeId)
  if (row?.status !== 'permission') {
    setAskPhase(deps.store, notificationId, worktreeId, 'failed')
    return
  }

  setAskPhase(deps.store, notificationId, worktreeId, 'sending')

  let resolution: Awaited<ReturnType<typeof resolveWaitingTerminalHandle>>
  try {
    resolution = await resolveWaitingTerminalHandle(session.client, worktreeId)
  } catch {
    setAskPhase(deps.store, notificationId, worktreeId, 'unresolved') // HIGH #2/#3: never swallow
    return
  }
  if (deps.sessions.current() !== session) {
    return // host switched while resolving — the new session's own effects own this now
  }
  if (!('handle' in resolution)) {
    // Fail closed (CRITICAL #10): zero or more than one terminal needs input — never guess.
    setAskPhase(deps.store, notificationId, worktreeId, 'failed')
    return
  }

  let response: RpcResponse
  try {
    response = await session.client.sendRequest('terminal.send', {
      terminal: resolution.handle,
      text: keys
    })
  } catch {
    setAskPhase(deps.store, notificationId, worktreeId, 'unresolved') // HIGH #2/#3: never swallow
    return
  }
  if (deps.sessions.current() !== session) {
    return
  }
  if (!isSendAccepted(response)) {
    // Rejected send (HIGH #3): keep the ask actionable — the footer offers a retry.
    setAskPhase(deps.store, notificationId, worktreeId, 'failed')
    return
  }

  setAskPhase(deps.store, notificationId, worktreeId, 'checking')
  session.dashboard.refreshNow()
  scheduleConfirmationPoll(deps, session, notificationId, worktreeId)
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
