// Contract module (Unit 0): HudState + slice shapes from spec S8, plus a tiny observable
// store (no framework). Unit 4 implements the slice reducers/schedulers over this store;
// Unit 5 implements NavState transitions via reduceHudInput.
import type { CompatVerdict } from '@orca-shared/protocol-compat'
import type { GlassesDeviceSnapshot } from '../glasses/glasses-bridge'
import type { ConnectionState } from '../transport/orca-rpc-wire'
import type { NavState } from '../navigation/nav-contract'

// Mirrors the shape Unit 3's host-profile-store.ts owns/exports; defined here so Unit 0's
// HudState compiles standalone before Unit 3 lands. Unit 3's export is the authority.
export type GlassesHostProfile = {
  id: string
  name: string
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  lastConnected: number
}

export type ConnectionSlice = {
  hostId: string | null
  state: ConnectionState
  compat: CompatVerdict | null
  lastError?: string
}

export type DashboardRow = {
  worktreeId: string
  displayName: string
  status?: 'working' | 'active' | 'permission' | 'done' | 'inactive'
  elapsedLabel?: string // absent when the source lastOutputAt is missing
}

export type DashboardSlice = {
  rows: DashboardRow[]
  fetchedAt: number
  stale: boolean
}

export type NotificationInboxEntry = {
  notificationId: string
  title: string
  body: string
  worktreeId?: string
  receivedAt: number
  kind: 'ask' | 'done' | 'info'
  // Finding #13: once this entry's worktree leaves `permission` (or a newer entry takes over
  // as the current episode's ask), it is permanently ineligible for re-promotion to 'ask' —
  // otherwise a historical notification can resurrect as the "current" ask on a later,
  // unrelated permission episode that hasn't produced its own notification yet.
  retiredAsk?: true
}

export type NotificationInboxSlice = {
  entries: NotificationInboxEntry[] // ring buffer, last 20
}

export type TerminalTailSlice = {
  terminalId: string | null
  lines: string[]
  live: boolean
  // Set when the host's terminal.subscribe stream never negotiated/delivered binary frames
  // (older host, or the JSON fallback path — full JSON terminal decoding is v2). Screens should
  // render an "unavailable" state instead of an empty tail. Optional so existing initial-state
  // literals ({ terminalId: null, lines: [], live: false }) keep compiling.
  unavailable?: boolean
  // Added for the terminal-tail screen agent (not populated by this unit): true from the moment
  // terminal.subscribe is requested until the first frame (or `unavailable`) lands, so the
  // screen can render "Loading terminal…" instead of an empty tail during that window. Optional
  // so existing initial-state literals keep compiling.
  loading?: boolean
}

// Integrator wiring (Unit 8, CRITICAL findings #10/#11, HIGH #2/#12): per-prompt latch +
// footer state for the ask screen, replacing the old optimistic-only AskAnsweredSlice.
// - 'idle': no interaction yet for this notification/worktree — ask-screen shows its default
//   footer/options.
// - 'sending': a terminal.send round-trip (after re-resolving the waiting terminal) is in
//   flight. NavContext.askSendInFlight uses this to make the reducer ignore a second click
//   instead of racing a second terminal.send (CRITICAL #11).
// - 'checking': terminal.send was accepted; a bounded set of worktree.ps confirmation refreshes
//   is running to see whether the worktree actually left `permission` (HIGH #12).
// - 'answered': a confirmation refresh observed the worktree leave `permission`.
// - 'failed': the host explicitly told us the answer did not go through (no unique waiting
//   terminal, or terminal.send responded but `accepted: false`) — retry is safe and expected.
// - 'unresolved': we cannot tell what happened (a request threw/timed out, or bounded
//   confirmation checks were exhausted while still `permission`) — never optimistic, and
//   further sends are blocked until the wearer checks their phone.
export type AskInteraction = {
  notificationId: string
  worktreeId: string
  phase: 'idle' | 'sending' | 'checking' | 'answered' | 'failed' | 'unresolved'
  updatedAt: number
} | null

export type HudState = {
  connection: ConnectionSlice
  hosts: GlassesHostProfile[]
  dashboard: DashboardSlice
  inbox: NotificationInboxSlice
  terminalTail: TerminalTailSlice
  device: GlassesDeviceSnapshot | null
  askInteraction: AskInteraction
  nav: NavState
}

export type HudStore = {
  getState(): HudState
  update(fn: (state: HudState) => HudState): void // notifies subscribers on change
  subscribe(listener: (state: HudState) => void): () => void
}

export function createHudStore(initial: HudState): HudStore {
  let state = initial
  const listeners = new Set<(state: HudState) => void>()

  return {
    getState: () => state,
    update: (fn) => {
      const next = fn(state)
      if (next === state) {
        return // no-op update should not notify
      }
      state = next
      for (const listener of listeners) {
        listener(state)
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
