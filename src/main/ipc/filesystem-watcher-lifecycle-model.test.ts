import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWatcherSender, fireWatcherSenderEvent } from './filesystem-watcher-test-sender'

const { handleMock, statMock, subscribeMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  statMock: vi.fn(),
  subscribeMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('./filesystem/watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeMock,
  disposeWatcherProcess: vi.fn()
}))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))
import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import { desktopWorktreeWatcherRemoval } from './filesystem-watcher'
import { setWorktreeWatcherRemoval } from './worktree-watcher-removal'
import { createRuntimeFileWatcherRemoval } from '../runtime/runtime-file-watcher-removal'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import {
  resetWatcherChildRegistryForTest,
  WatcherChildCapacityError
} from './filesystem/watcher-process/parcel-watcher-child-registry'

type Handler = (event: unknown, args: unknown) => unknown
type Sender = ReturnType<typeof createWatcherSender> & { destroyed: boolean }
type SubscribeOutcome = 'ok' | 'capacity'
// Wedged children ignore abort; removal must still meet its deadline.
type SubscribeDelay = 'none' | 'abortable' | 'wedged'
// A removal-refused watch can return through that removal's restore.
type Intent = 'yes' | 'no' | 'rejected'
type Removal = {
  path: string
  finish: ((removed: boolean) => Promise<void>) | null
}

const ROOTS = ['/repo', '/other']
const OUTCOMES: SubscribeOutcome[] = ['ok', 'ok', 'ok', 'capacity']
const DELAYS: SubscribeDelay[] = ['none', 'none', 'abortable', 'abortable', 'abortable', 'wedged']
// Increase ORCA_WATCH_MODEL_RUNS for deeper local searches.
const RUNS = Number(process.env.ORCA_WATCH_MODEL_RUNS ?? 1000)
const MIN_STEPS = 20
const MAX_STEPS = 60
const GRACE_PLUS_MS = 31_000

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function rootKey(worktreePath: string): string {
  return getLocalWatcherRoot(worktreePath).key
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve()
  }
  await vi.advanceTimersByTimeAsync(0)
}

describe('local watcher lifecycle (randomized model)', () => {
  const handlers: Record<string, Handler> = {}
  const deferred: (() => void)[] = []
  let liveSubscriptions = 0
  let nextOutcome: () => { outcome: SubscribeOutcome; delay: SubscribeDelay }
  let trace: string[] = []
  const coordinator = createRuntimeFileWatcherRemoval({
    closeFileExplorerWatchersForPath: async () => {},
    restoreFileExplorerWatchersAfterFailedRemoval: async () => {},
    forgetFileExplorerWatchersAfterRemoval: () => {}
  })

  async function resolveAllDeferred(): Promise<void> {
    while (deferred.length > 0) {
      deferred.shift()!()
      await settle()
    }
  }

  function waitForRelease(signal: AbortSignal | undefined, delay: SubscribeDelay): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = (): void => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = (): void => {
        deferred.splice(deferred.indexOf(done), 1)
        reject(new Error('aborted'))
      }
      deferred.push(done)
      if (delay === 'abortable') {
        signal?.addEventListener('abort', abort, { once: true })
      }
    })
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    resetWatcherChildRegistryForTest()
    setWorktreeWatcherRemoval(desktopWorktreeWatcherRemoval)
    handleMock.mockImplementation((channel: string, handler: Handler) => {
      handlers[channel] = handler
    })
    statMock.mockResolvedValue({ isDirectory: () => true })
    subscribeMock.mockImplementation(
      async (dir: string, _cb: unknown, _opts: unknown, hooks?: { signal?: AbortSignal }) => {
        const { outcome, delay } = nextOutcome()
        trace.push(`  subscribe ${dir}: ${delay} ${outcome}`)
        if (delay !== 'none') {
          await waitForRelease(hooks?.signal, delay)
        }
        if (outcome === 'capacity') {
          throw new WatcherChildCapacityError()
        }
        liveSubscriptions += 1
        let unsubscribed = false
        return {
          unsubscribe: vi.fn(async () => {
            if (unsubscribed) {
              throw new Error('double unsubscribe')
            }
            unsubscribed = true
            liveSubscriptions -= 1
          })
        }
      }
    )
    deferred.length = 0
    liveSubscriptions = 0
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  afterEach(async () => {
    await resolveAllDeferred()
    await closeAllWatchers()
    setWorktreeWatcherRemoval(null)
    resetWatcherChildRegistryForTest()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  async function runModel(seed: number, steps: number): Promise<string | null> {
    const rand = mulberry32(seed)
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]
    nextOutcome = () => ({ outcome: pick(OUTCOMES), delay: pick(DELAYS) })
    deferred.length = 0
    liveSubscriptions = 0
    let nextSenderId = 1
    const makeSender = (): Sender => {
      const sender = Object.assign(createWatcherSender(nextSenderId++), {
        destroyed: false
      })
      sender.isDestroyed = () => sender.destroyed
      return sender
    }
    const senders: Sender[] = [makeSender(), makeSender(), makeSender()]
    // Last requested intent per sender/root; absent means never requested.
    const wanted = new Map<string, Intent>()
    const lastWatchOp = new Map<string, number>()
    const want = (senderId: number, key: string): string => `${senderId}|${key}`
    let nextOp = 0
    trace = []
    const inFlight: Promise<unknown>[] = []
    const removals: Removal[] = []
    const failed = (message: string): string => `${message}\n${trace.join('\n')}`
    const liveSenders = (): Sender[] => senders.filter((candidate) => !candidate.destroyed)

    // Use the real coordinator to exercise install fences and removal gate ordering.
    const startRemoval = (path: string): void => {
      const removal: Removal = { path, finish: null }
      removals.push(removal)
      inFlight.push(
        coordinator.acquire(path).then(
          (handle) => {
            removal.finish = handle.finish
          },
          () => {
            removals.splice(removals.indexOf(removal), 1)
          }
        )
      )
    }

    const finishRemoval = (removal: Removal, removed: boolean): void => {
      removals.splice(removals.indexOf(removal), 1)
      trace.push(`finish removal ${removal.path} (${removed ? 'succeeds' : 'fails, restore'})`)
      // Restore may start another deferred subscription; keep it in flight.
      inFlight.push(removal.finish!(removed))
      if (!removed) {
        return
      }
      const key = rootKey(removal.path)
      for (const owner of liveSenders()) {
        if (wanted.has(want(owner.id, key))) {
          wanted.set(want(owner.id, key), 'no')
          handlers['fs:unwatchWorktree']({ sender: owner }, { worktreePath: removal.path })
        }
      }
    }

    const drain = async (): Promise<void> => {
      while (deferred.length > 0 || inFlight.length > 0 || removals.length > 0) {
        await resolveAllDeferred()
        await Promise.allSettled(inFlight.splice(0))
        await settle()
        for (const removal of removals.filter((candidate) => candidate.finish)) {
          finishRemoval(removal, rand() < 0.5)
        }
        await settle()
      }
    }

    const checkListeners = (phase: string): string | null => {
      const sources = [
        ['listens on', watcherLifecycleState.watchedRoots],
        ['waits on capacity for', watcherLifecycleState.pendingLocalCapacityRetries]
      ] as const
      for (const [label, byKey] of sources) {
        for (const [key, { listeners }] of byKey) {
          for (const senderId of listeners.keys()) {
            const intent = wanted.get(want(senderId, key))
            if (intent !== 'yes' && intent !== 'rejected') {
              return `${phase}: unwatched sender ${senderId} still ${label} ${key}`
            }
          }
        }
      }
      return null
    }

    for (let step = 0; step < steps; step += 1) {
      const roll = rand()
      const sender = pick(liveSenders())
      const worktreePath = pick(ROOTS)
      const key = rootKey(worktreePath)
      const entry = want(sender.id, key)
      if (roll < 0.36) {
        trace.push(`watch s${sender.id} ${worktreePath}`)
        const op = nextOp++
        wanted.set(entry, 'yes')
        lastWatchOp.set(entry, op)
        inFlight.push(
          Promise.resolve(handlers['fs:watchWorktree']({ sender }, { worktreePath })).catch(() => {
            if (lastWatchOp.get(entry) === op && wanted.get(entry) === 'yes') {
              trace.push(`  watch s${sender.id} ${worktreePath} rejected`)
              wanted.set(entry, 'rejected')
            }
          })
        )
      } else if (roll < 0.58) {
        trace.push(`unwatch s${sender.id} ${worktreePath}`)
        wanted.set(entry, 'no')
        lastWatchOp.delete(entry)
        handlers['fs:unwatchWorktree']({ sender }, { worktreePath })
      } else if (roll < 0.72 && deferred.length > 0) {
        trace.push('resolve-subscribe')
        deferred.splice(Math.floor(rand() * deferred.length), 1)[0]()
      } else if (roll < 0.77) {
        trace.push('grace-elapses')
        await vi.advanceTimersByTimeAsync(GRACE_PLUS_MS)
      } else if (roll < 0.84) {
        trace.push(`start removal ${worktreePath}`)
        startRemoval(worktreePath)
      } else if (roll < 0.91 && removals.some((removal) => removal.finish)) {
        finishRemoval(pick(removals.filter((removal) => removal.finish)), rand() < 0.5)
      } else if (roll < 0.97) {
        // Reload preserves WebContents ID but retires the page's watch lifetime.
        const closes = rand() < 0.5
        trace.push(`window s${sender.id} ${closes ? 'closes' : 'reloads'}`)
        sender.destroyed = closes
        fireWatcherSenderEvent(sender, closes ? 'destroyed' : 'did-navigate')
        for (const wantedEntry of wanted.keys()) {
          if (wantedEntry.startsWith(`${sender.id}|`)) {
            wanted.set(wantedEntry, 'no')
            lastWatchOp.delete(wantedEntry)
          }
        }
        if (closes) {
          senders.push(makeSender())
        }
      }
      await settle()
      const stepFailure = checkListeners(`step ${step}`)
      if (stepFailure) {
        return failed(stepFailure)
      }
    }

    trace.push('drain')
    await drain()
    const quiescent = checkListeners('quiescent')
    if (quiescent) {
      return failed(quiescent)
    }
    for (const key of watcherLifecycleState.watchedRoots.keys()) {
      if (watcherLifecycleState.inFlightLocalInstalls.has(key)) {
        return failed(`root ${key} is installed and still installing`)
      }
    }
    if (liveSubscriptions !== watcherLifecycleState.watchedRoots.size) {
      return failed(
        `${liveSubscriptions} native subscriptions for ${watcherLifecycleState.watchedRoots.size} roots`
      )
    }
    for (const [entry, intent] of wanted) {
      const [senderIdText, key] = entry.split('|')
      const senderId = Number(senderIdText)
      const listening = watcherLifecycleState.watchedRoots.get(key)?.listeners.has(senderId)
      const capacityWaiting = watcherLifecycleState.pendingLocalCapacityRetries
        .get(key)
        ?.listeners.has(senderId)
      if (intent === 'yes' && !listening && !capacityWaiting) {
        return failed(`wanted ${entry} is neither delivered nor waiting`)
      }
    }

    for (const sender of liveSenders()) {
      for (const worktreePath of ROOTS) {
        wanted.set(want(sender.id, rootKey(worktreePath)), 'no')
        handlers['fs:unwatchWorktree']({ sender }, { worktreePath })
      }
    }
    await vi.advanceTimersByTimeAsync(GRACE_PLUS_MS)
    await settle()
    const leaked = {
      watchedRoots: watcherLifecycleState.watchedRoots.size,
      pendingTeardowns: watcherLifecycleState.pendingTeardowns.size,
      inFlightInstalls: watcherLifecycleState.inFlightLocalInstalls.size,
      pendingInstalls: watcherLifecycleState.pendingLocalInstallPromises.size,
      capacityRetries: watcherLifecycleState.pendingLocalCapacityRetries.size,
      suspended: watcherLifecycleState.suspendedLocalWatcherListeners.size,
      liveSubscriptions
    }
    if (Object.values(leaked).some((count) => count !== 0)) {
      return failed(`leaked after full unwatch: ${JSON.stringify(leaked)}`)
    }
    return null
  }

  it('drops a re-watch that was unwatched while waiting out a cancelled install', async () => {
    nextOutcome = () => ({ outcome: 'ok', delay: 'abortable' })
    const sender = createWatcherSender(1)
    const args = { worktreePath: '/repo' }
    const first = handlers['fs:watchWorktree']({ sender }, args)
    await settle()
    handlers['fs:unwatchWorktree']({ sender }, args)
    const second = handlers['fs:watchWorktree']({ sender }, args)
    await settle()
    handlers['fs:unwatchWorktree']({ sender }, args)
    await resolveAllDeferred()
    await Promise.all([first, second])
    await settle()

    expect(watcherLifecycleState.watchedRoots.get(rootKey('/repo'))?.listeners.has(1)).not.toBe(
      true
    )
    await vi.advanceTimersByTimeAsync(GRACE_PLUS_MS)
    expect(liveSubscriptions).toBe(0)
  })

  it('never leaks listeners, roots or native subscriptions across random watch histories', async () => {
    for (let run = 0; run < RUNS; run += 1) {
      const seed = 7_000_000 + run
      const failure = await runModel(seed, MIN_STEPS + (seed % (MAX_STEPS - MIN_STEPS + 1)))
      if (failure) {
        expect(`seed ${seed}: ${failure}`).toBeNull()
      }
      await resolveAllDeferred()
      await closeAllWatchers()
      await settle()
    }
  }, 600_000)
})
