import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { getAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { waitForPromiseWithSignal } from '../../../shared/concurrency/abort-signal-reason'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import { WorkerThreadRequestQueue } from '../../worker-threads/worker-thread-request-queue'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type { PtySpawnOptions } from '../pty/provider-contract'
import {
  rexLaunchJob,
  rexLaunchResult,
  type RexLaunchJob,
  type RexLaunchResponse
} from './rex-launch-worker-schema'

export type RexLaunchPayloadFactory = (opts: PtySpawnOptions, cwd: string) => Promise<Buffer>
type Planner = {
  key: string
  queue: WorkerThreadRequestQueue<RexLaunchJob, RexLaunchResponse>
  ready: Promise<void>
  users: number
}
let active = 0
let cached: Planner | undefined
const MAX_ACTIVE = 8
const TIMEOUT_MS = 5000

// Retain only a digest, not a second copy of ambient credentials. A worker inherits one
// environment and profile; it must never plan a later request under a different context.
function environmentKey(): string {
  return createHash('sha256')
    .update(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))))
    .digest('hex')
}

function acquirePlanner(workerPath: string, profile: string): Planner {
  const environment = environmentKey()
  const key = JSON.stringify([workerPath, profile, environment])
  if (cached?.key === key && cached.users === 0) {
    return cached
  }
  const queue = new WorkerThreadRequestQueue<RexLaunchJob, RexLaunchResponse>({
    factory: () => {
      if (environmentKey() !== environment) {
        throw new Error('Rex launch environment changed')
      }
      return spawnWorkerThread(workerPath, {
        name: 'orca-rex-launch',
        workerData: profile,
        resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 }
      })
    },
    idleTeardownMs: 15_000,
    maxConsecutiveDeaths: 1,
    queueCap: { maxQueuedCalls: 1, describeFull: () => 'Rex launch planner busy' },
    awaitRetirement: true,
    createUnavailableError: () => new Error('Rex launch planner unavailable'),
    describeTimeout: () => 'Rex launch planning timed out',
    describeExit: () => 'Rex launch planner exited',
    describeCrashLoop: () => 'Rex launch planner failed',
    onUnavailable: () => {}
  })
  const previous = cached
  const planner: Planner = { key, queue, ready: Promise.resolve(), users: 0 }
  // Concurrent launches retain independent cancellation and deadlines. Only the
  // idle matching worker is reused; every overlapping request has its own worker.
  if (!previous || previous.users === 0) {
    previous?.queue.dispose()
    planner.ready = previous
      ? previous.ready.then(() => previous.queue.retired())
      : Promise.resolve()
    cached = planner
  }
  return planner
}

export function createRexLaunchPayloadFactory(
  workerPath = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(__dirname),
    'rex-launch-worker-entry.js'
  ),
  profilePath?: string
): RexLaunchPayloadFactory {
  return async (opts, cwd) => {
    if (opts.signal?.aborted) {
      throw new Error('client_disconnected')
    }
    if (active >= MAX_ACTIVE) {
      throw new Error('Rex launch planner busy')
    }
    const profile = profilePath ?? getAppEnvironment().getPath('userData')
    if (!isAbsolute(profile) || !isAbsolute(workerPath)) {
      throw new Error('Absolute Rex launch worker paths required')
    }
    const planner = acquirePlanner(workerPath, profile)
    planner.users++
    active++
    const deadline = new AbortController()
    // Bound queue time as well as execution. A referenced deadline also keeps standalone
    // Node callers alive while the shared worker host is unref'ed.
    const timer = setTimeout(
      () => deadline.abort(new Error('Rex launch planning timed out')),
      TIMEOUT_MS
    )
    const abort = () => deadline.abort(new Error('client_disconnected'))
    opts.signal?.addEventListener('abort', abort, { once: true })
    if (opts.signal?.aborted) {
      abort()
    }
    const signal = deadline.signal
    try {
      await waitForPromiseWithSignal(planner.ready, signal)
      const response = await planner.queue
        .dispatch((id) => rexLaunchJob.parse({ id, profile, cwd, opts }), TIMEOUT_MS, signal)
        .catch((error: unknown) => {
          signal.throwIfAborted()
          // Worker exceptions may include launch arguments or environment contents.
          // Preserve only fixed diagnostic messages, never the original Error or its cause.
          const message = error instanceof Error ? error.message : ''
          throw new Error(
            message === 'Rex launch planner unavailable' ||
              message === 'Rex launch planner exited' ||
              message === 'Rex launch planning timed out'
              ? message
              : 'Rex launch planner worker failed'
          )
        })
      const parsed = rexLaunchResult.safeParse(response)
      if (!parsed.success) {
        throw new Error('Rex launch planning failed')
      }
      try {
        if (parsed.data.payload.length > 256 * 1024) {
          throw new Error('Rex launch planning failed')
        }
        return Buffer.from(parsed.data.payload)
      } finally {
        parsed.data.payload.fill(0)
      }
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', abort)
      try {
        if (cached !== planner) {
          planner.queue.dispose()
        }
        // Cancellation/fault can settle a request before its worker actually exits.
        // Keep admission and planner ownership until retirement has completed.
        await planner.queue.retired()
      } finally {
        planner.users--
        active--
      }
    }
  }
}
