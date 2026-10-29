/** Fake ports and fixtures for the move orchestrator's tests. */
import { vi } from 'vitest'
import type {
  WslMoveBlocker,
  WslMovePreview,
  WslMoveResult
} from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveOrchestratorRecord } from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import type { WslMoveOrchestrator } from './wsl-move-orchestrator'
import type { WslMoveOrchestratorPorts } from './wsl-move-orchestrator-ports'

export const blocker: WslMoveBlocker = {
  kind: 'agent-working',
  ids: ['tab:leaf'],
  actions: ['wait']
}

export function ready(distro: string, blockers: WslMoveBlocker[] = []): WslMovePreview {
  return {
    outcome: 'ready',
    distro,
    repoIds: ['r1'],
    folderWorkspaceIds: [],
    changed: [],
    heldByHost: [],
    refused: [],
    blockers
  }
}

export const moved: WslMoveResult = {
  outcome: 'moved',
  migrationId: 'm1',
  phase: 'retained',
  reloadRequired: true
}

export type Fake = WslMoveOrchestratorPorts & {
  clock: { now: number }
  timers: { at: number; run: () => void; cancelled: boolean }[]
  saved: Map<string, WslMoveOrchestratorRecord>
  /** Distros a step ran for as the user's act, in order. */
  userActs: string[]
  advance: (ms: number) => Promise<void>
}

export function fakePorts(overrides: Partial<WslMoveOrchestratorPorts> = {}): Fake {
  const clock = { now: 1_000 }
  const timers: Fake['timers'] = []
  const saved = new Map<string, WslMoveOrchestratorRecord>()
  const userActs: string[] = []
  const ports: Fake = {
    clock,
    timers,
    saved,
    now: () => clock.now,
    appVersion: '1.0.0',
    autoMoveEnabled: () => true,
    prepareHost: vi.fn(async () => 'ready' as const),
    isHostReady: vi.fn(() => true),
    hostRemovalPending: vi.fn(() => false),
    hasHost: vi.fn(() => true),
    isDistroInUse: vi.fn(() => true),
    preview: vi.fn(async (distro: string) => ready(distro)),
    start: vi.fn(async () => moved),
    finishedMove: () => null,
    checkMovedDistro: vi.fn(async () => 'present' as const),
    releaseFinishedMove: vi.fn(async () => ({
      released: true as const,
      distro: 'Ubuntu',
      repoIds: ['r1'],
      folderWorkspaceIds: []
    })),
    load: () => new Map(),
    save: (records) => {
      saved.clear()
      for (const [key, value] of records) {
        saved.set(key, value)
      }
    },
    schedule: (delayMs, run) => {
      const timer = { at: clock.now + delayMs, run, cancelled: false }
      timers.push(timer)
      return () => {
        timer.cancelled = true
      }
    },
    track: vi.fn(),
    publish: vi.fn(),
    userActs,
    runAsUserAct: <T>(distro: string, act: () => Promise<T>): Promise<T> => {
      userActs.push(distro)
      return act()
    },
    advance: async (ms) => {
      clock.now += ms
      for (const timer of timers.splice(0)) {
        if (!timer.cancelled && timer.at <= clock.now) {
          timer.run()
        } else if (!timer.cancelled) {
          timers.push(timer)
        }
      }
      // Let the triggered runs settle their awaited ports.
      for (let turn = 0; turn < 10; turn++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
    },
    ...overrides
  }
  return ports
}

export function stateOf(orchestrator: WslMoveOrchestrator, distro: string) {
  return orchestrator.list().find((record) => record.distro === distro)?.state
}
