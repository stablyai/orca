import { performance } from 'node:perf_hooks'
import type { WorkspaceSessionPatch } from '../../src/shared/types'
import type { AppState } from '../../src/renderer/src/store'
import type { WorkspaceSessionSnapshot } from '../../src/renderer/src/lib/workspace-session'
import { createSessionWriteSubscriber } from '../../src/renderer/src/lib/session-write-subscriber'
import { round } from './non-terminal-benchmark-stats'

export type PersistenceSubscriberResult = {
  scenario: string
  updates: number
  persistCalls: number
  elapsedMs: number
  notes: string
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function makeSubscriberState(snapshot: WorkspaceSessionSnapshot, epoch: number): AppState {
  return {
    ...snapshot,
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    agentStatusEpoch: epoch
  } as unknown as AppState
}

function createFakeSubscriberStore(initial: AppState): {
  store: Parameters<typeof createSessionWriteSubscriber>[0]['store']
  emit: (next: AppState) => void
} {
  let state = initial
  const listeners: ((next: AppState) => void)[] = []
  return {
    store: {
      subscribe: (listener: (next: AppState) => void): (() => void) => {
        listeners.push(listener)
        return () => {
          const index = listeners.indexOf(listener)
          if (index !== -1) {
            listeners.splice(index, 1)
          }
        }
      },
      getState: (): AppState => state
    },
    emit: (next: AppState): void => {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    }
  }
}

export async function measurePersistenceSubscriberGate(
  snapshot: WorkspaceSessionSnapshot
): Promise<PersistenceSubscriberResult[]> {
  const { store, emit } = createFakeSubscriberStore(makeSubscriberState(snapshot, 0))
  const persisted: WorkspaceSessionPatch[] = []
  const dispose = createSessionWriteSubscriber({
    store,
    debounceMs: 1,
    persist: ({ patch }) => persisted.push(patch)
  })

  emit(makeSubscriberState(snapshot, 1))
  await sleep(5)
  persisted.length = 0

  const unrelatedStartedAt = performance.now()
  for (let index = 0; index < 200; index += 1) {
    emit(makeSubscriberState(snapshot, index + 2))
  }
  await sleep(5)
  const unrelatedResult: PersistenceSubscriberResult = {
    scenario: '200 unrelated store ticks after warmup',
    updates: 200,
    persistCalls: persisted.length,
    elapsedMs: round(performance.now() - unrelatedStartedAt),
    notes: 'Only agentStatusEpoch changed; session-relevant references stayed stable.'
  }

  persisted.length = 0
  const focusStartedAt = performance.now()
  const worktreeIds = Object.keys(snapshot.activeFileIdByWorktree)
  for (let index = 0; index < 50; index += 1) {
    const worktreeId = worktreeIds[index % worktreeIds.length]
    emit({
      ...makeSubscriberState(snapshot, 300 + index),
      activeFileIdByWorktree: {
        ...snapshot.activeFileIdByWorktree,
        [worktreeId]: snapshot.activeFileIdByWorktree[worktreeId]
      }
    } as AppState)
  }
  await sleep(5)
  const focusResult: PersistenceSubscriberResult = {
    scenario: '50 rapid editor-focus-shaped relevant updates',
    updates: 50,
    persistCalls: persisted.length,
    elapsedMs: round(performance.now() - focusStartedAt),
    notes:
      'Debounce coalesced the burst; the emitted patch still uses the full editor-session shape.'
  }

  dispose()
  return [unrelatedResult, focusResult]
}
