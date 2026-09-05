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
}

export type NotificationInboxSlice = {
  entries: NotificationInboxEntry[] // ring buffer, last 20
}

export type TerminalTailSlice = {
  terminalId: string | null
  lines: string[]
  live: boolean
}

// Integrator wiring (Unit 8): tracks the optimistic "answered" footer on the ask screen (spec
// S7) — set right after a successful terminal.send, cleared implicitly once a different ask
// is answered. sentAt is compared against dashboard.fetchedAt to know whether the "next poll"
// (spec's confirmation step) has happened yet.
export type AskAnsweredSlice = { worktreeId: string; sentAt: number } | null

export type HudState = {
  connection: ConnectionSlice
  hosts: GlassesHostProfile[]
  dashboard: DashboardSlice
  inbox: NotificationInboxSlice
  terminalTail: TerminalTailSlice
  device: GlassesDeviceSnapshot | null
  askAnswered: AskAnsweredSlice
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
