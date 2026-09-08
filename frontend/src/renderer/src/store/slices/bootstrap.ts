// Bootstrap slice — per-server dev environment setup automation (CR-004)
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

// ─── Types ────────────────────────────────────────────────────────────────────

export type BootstrapStepStatus = 'pending' | 'running' | 'done' | 'error' | 'skipped'

export type BootstrapStep = {
  id: string
  label: string
  status: BootstrapStepStatus
  /** Success detail, e.g. "Node.js v22.3.0 detected" */
  detail: string | null
  error: string | null
}

export type BootstrapPhase = 'idle' | 'running' | 'done' | 'error'

export type ServerBootstrapState = {
  serverId: string
  phase: BootstrapPhase
  steps: BootstrapStep[]
  logLines: string[]
  startedAt: number | null
  completedAt: number | null
}

export type BootstrapSlice = {
  bootstrapByServer: Record<string, ServerBootstrapState>

  initBootstrap: (serverId: string) => void
  updateBootstrapStep: (serverId: string, stepId: string, update: Partial<BootstrapStep>) => void
  appendBootstrapLog: (serverId: string, line: string) => void
  finishBootstrap: (serverId: string, success: boolean) => void
  clearBootstrap: (serverId: string) => void
  /** Hydrates a coarse `phase` for serverId from its already-loaded
   *  `devServers` entry's `healthStatus` — fixes the "mid-bootstrap page
   *  refresh always shows the idle/start screen" gap (BACKLOG-007), without
   *  a dedicated per-step bootstrap field: `pending` reads as "still
   *  bootstrapping" (phase 'running', no step detail — this backend signal
   *  cannot say which step), `healthy` reads as done. `degraded`/
   *  `unhealthy`/missing healthStatus (older backend, or genuinely no dev
   *  server row yet) intentionally do NOT set phase — a health problem is a
   *  different concern than bootstrap-in-progress, and there's no safe
   *  default to assume for "field absent" (see DevServer.healthStatus's own
   *  doc comment). No-op when bootstrapByServer[serverId] already has real
   *  state (e.g. live IPC events already populated it) — never clobbers a
   *  more specific, already-known state with this coarse fallback.
   *  Synchronous: reads only already-hydrated `devServers` (see
   *  dev-servers.ts's hydrateDevServers/useDevServersSync), no RPC of its
   *  own — call after devServers is known to be loaded. */
  resumeBootstrapProgressIfAny: (serverId: string) => void
}

const DEFAULT_BOOTSTRAP_STEPS: BootstrapStep[] = [
  { id: 'node', label: 'Node.js 22+', status: 'pending', detail: null, error: null },
  { id: 'git', label: 'Git 2.35+', status: 'pending', detail: null, error: null },
  { id: 'ssh-key', label: 'SSH key setup', status: 'pending', detail: null, error: null },
  { id: 'repos', label: 'Clone/update repos', status: 'pending', detail: null, error: null },
  { id: 'setup-script', label: 'Run setup scripts', status: 'pending', detail: null, error: null }
]

const MAX_LOG_LINES = 500

// ─── Slice Factory ────────────────────────────────────────────────────────────

export const createBootstrapSlice: StateCreator<AppState, [], [], BootstrapSlice> = (set, get) => ({
  bootstrapByServer: {},

  initBootstrap: (serverId) =>
    set((s) => ({
      bootstrapByServer: {
        ...s.bootstrapByServer,
        [serverId]: {
          serverId,
          phase: 'running',
          startedAt: Date.now(),
          completedAt: null,
          logLines: [],
          // Deep-copy the default steps so each server gets an independent array
          steps: DEFAULT_BOOTSTRAP_STEPS.map((step) => ({ ...step }))
        } satisfies ServerBootstrapState
      }
    })),

  updateBootstrapStep: (serverId, stepId, update) =>
    set((s) => {
      const serverState = s.bootstrapByServer[serverId]
      if (!serverState) {
        return s
      }
      const stepIdx = serverState.steps.findIndex((st) => st.id === stepId)
      if (stepIdx === -1) {
        return s
      }
      const updatedSteps = serverState.steps.slice()
      updatedSteps[stepIdx] = { ...updatedSteps[stepIdx], ...update }
      return {
        bootstrapByServer: {
          ...s.bootstrapByServer,
          [serverId]: { ...serverState, steps: updatedSteps }
        }
      }
    }),

  appendBootstrapLog: (serverId, line) =>
    set((s) => {
      const serverState = s.bootstrapByServer[serverId]
      if (!serverState) {
        return s
      }
      // Cap at MAX_LOG_LINES — drop oldest when full
      const prev = serverState.logLines
      const next = prev.length >= MAX_LOG_LINES ? [...prev.slice(1), line] : [...prev, line]
      return {
        bootstrapByServer: {
          ...s.bootstrapByServer,
          [serverId]: { ...serverState, logLines: next }
        }
      }
    }),

  finishBootstrap: (serverId, success) =>
    set((s) => {
      const serverState = s.bootstrapByServer[serverId]
      if (!serverState) {
        return s
      }
      return {
        bootstrapByServer: {
          ...s.bootstrapByServer,
          [serverId]: {
            ...serverState,
            phase: success ? 'done' : 'error',
            completedAt: Date.now()
          }
        }
      }
    }),

  clearBootstrap: (serverId) =>
    set((s) => {
      const { [serverId]: _, ...rest } = s.bootstrapByServer
      return { bootstrapByServer: rest }
    }),

  resumeBootstrapProgressIfAny: (serverId) => {
    if (get().bootstrapByServer[serverId]) {
      return
    }
    const devServer = get().devServers.find((ds) => ds.id === serverId)
    if (devServer?.healthStatus === 'pending') {
      set((s) => ({
        bootstrapByServer: {
          ...s.bootstrapByServer,
          [serverId]: {
            serverId,
            phase: 'running',
            startedAt: null,
            completedAt: null,
            logLines: [],
            steps: DEFAULT_BOOTSTRAP_STEPS.map((step) => ({ ...step }))
          } satisfies ServerBootstrapState
        }
      }))
    } else if (devServer?.healthStatus === 'healthy') {
      set((s) => ({
        bootstrapByServer: {
          ...s.bootstrapByServer,
          [serverId]: {
            serverId,
            phase: 'done',
            startedAt: null,
            completedAt: null,
            logLines: [],
            steps: DEFAULT_BOOTSTRAP_STEPS.map((step) => ({ ...step, status: 'done' }))
          } satisfies ServerBootstrapState
        }
      }))
    }
  }
})
