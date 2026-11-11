// Main-process residency on an independent, uniform completed-tool seed; subscriptions retain no payloads in the driver.
import { workerMemory } from './native-chat-4a-worker-memory'
import { setTimeout as delay } from 'node:timers/promises'
import { seededChats } from './native-chat-4a-fixture'
import type { Row } from './native-chat-4a-report'
import { stat } from './native-chat-4a-report'
import { page, type RunContext } from './native-chat-4a-run-context'
import { history } from './native-chat-4a-session'
import type { Workload } from './native-chat-4a-workloads'

const METRICS = ['heapUsed', 'rss', 'external', 'arrayBuffers'] as const
const PHASES = [
  'before activation',
  'after activation',
  'activation delta',
  'before activation post-GC',
  'after activation post-GC',
  'activation delta post-GC'
] as const
type Phase = (typeof PHASES)[number]
type Memory = Partial<Record<(typeof METRICS)[number], number>> & {
  workers?: Awaited<ReturnType<typeof workerMemory>>
  workerError?: string
}
const WINDOW = 5
const INTERVAL_MS = 1000
const SETTLE_TIMEOUT_MS = 60_000

/** Kept outside the established history workload, including its cache directory and recipe digest. */
export function memoryWorkload(workload: Workload): Workload {
  const tools = workload.profile === 'full' ? 480 : 48
  return {
    ...workload,
    history: {
      largeTurns: 1,
      mediumTurns: 0,
      tools,
      toolOutputBytes: 32 * 1024,
      promptBytes: 300,
      replyBytes: 400,
      queuedEvery: 0,
      fillerChats: (workload.profile === 'full' ? 500 : 20) - 1,
      fillerTurns: 1,
      fillerTools: tools,
      fillerToolOutputBytes: 32 * 1024
    },
    diffs: { count: 0, patchBytes: 0 }
  }
}

export function memoryShape(workload: Workload): Record<string, number | string> {
  const { history: h } = memoryWorkload(workload)
  return {
    chats: h.fillerChats + 1,
    completedToolsPerChat: h.tools,
    toolOutputBytes: h.toolOutputBytes,
    outputPayloadBytes: (h.fillerChats + 1) * h.tools * h.toolOutputBytes,
    activation: 'agentSession.history then held agentSession.subscribe per chat; no provider start',
    source:
      'main-isolate memoryUsage plus read-only NodeWorker inspector inventory/heap; RSS is whole-process resident bytes, not physical footprint',
    settling: 'last 5 samples, 1s apart, heapUsed/RSS range <= max(5% of minimum, 8MiB); 60s limit'
  }
}

/** Even a launch or seed failure produces a named skipped row for every requested counter and phase. */
export function skipMissingMemoryRows(rows: Row[], workload: Workload, reason: string): void {
  for (const phase of PHASES) {
    for (const metric of METRICS) {
      const existing = rows.find(
        (row) => row.family === 'memory' && row.operation === metric && row.variant === phase
      )
      if (existing && existing.samples.length === 0 && !existing.skipped) {
        existing.skipped = reason
      }
      if (!existing) {
        rows.push({
          family: 'memory',
          operation: metric,
          variant: phase,
          samples: [],
          context: memoryShape(workload),
          skipped: reason
        })
      }
    }
  }
}

export async function memoryRows(ctx: RunContext): Promise<void> {
  const context = {
    ...memoryShape(ctx.workload),
    seedRecipe: ctx.manifest.recipe,
    seedArm: ctx.manifest.seedArm,
    seedSha: ctx.manifest.seedSha,
    seedMs: ctx.manifest.seedMs,
    seedStorageBytes: ctx.manifest.storageBytes,
    seedProfileLogicalBytes: ctx.manifest.profileBytes ?? 'not recorded in cached seed',
    mainPid: ctx.launch.pid
  }
  const rows = new Map<Phase, Row[]>()
  for (const phase of PHASES) {
    const group = METRICS.map((metric): Row => ({
      family: 'memory',
      operation: metric,
      variant: phase,
      samples: [],
      context
    }))
    ctx.rows.push(...group)
    rows.set(phase, group)
  }
  const groupFor = (phase: Phase): Row[] => rows.get(phase)!
  const skip = (phase: Phase, reason: string): void => {
    for (const row of groupFor(phase)) {
      row.skipped = reason
    }
  }
  const snapshot = async (): Promise<Memory> => {
    const memory = await ctx.launch.app.evaluate(() => {
      const { heapUsed, rss, external, arrayBuffers } = process.memoryUsage()
      return { heapUsed, rss, external, arrayBuffers }
    })
    try {
      return { ...memory, workers: await workerMemory(ctx.launch.app) }
    } catch (error) {
      return { ...memory, workerError: `worker attribution unexercised: ${String(error)}` }
    }
  }
  const measure = async (phase: Phase): Promise<void> => {
    const started = Date.now()
    const samples: Memory[] = []
    let stable = false
    do {
      if (samples.length > 0) {
        await delay(INTERVAL_MS)
      }
      samples.push(await snapshot())
      if (samples.length > WINDOW) {
        samples.shift()
      }
      stable =
        samples.length === WINDOW &&
        (['heapUsed', 'rss'] as const).every((metric) => {
          const values = samples.map((sample) => sample[metric])
          if (values.some((value) => value === undefined || !Number.isFinite(value))) {
            return false
          }
          const present = values.filter((value): value is number => typeof value === 'number')
          const min = Math.min(...present)
          return Math.max(...present) - min <= Math.max(min * 0.05, 8 * 1024 ** 2)
        })
    } while (!stable && Date.now() - started < SETTLE_TIMEOUT_MS)
    for (const row of groupFor(phase)) {
      row.context = { ...context, settleMs: Date.now() - started }
      for (const sample of samples) {
        const value = METRICS.find((metric) => metric === row.operation)
        const bytes = value ? sample[value] : undefined
        if (typeof bytes === 'number' && Number.isFinite(bytes)) {
          row.samples.push({
            extra: { bytes, observedWorkerCount: sample.workers?.count ?? Number.NaN },
            evidence: {
              workerInventory: sample.workers ?? null,
              workerError: sample.workerError ?? null
            }
          })
        }
      }
      if (!stable) {
        row.skipped = 'heapUsed/RSS did not settle within 60s; diagnostic samples only'
      } else if (row.samples.length !== WINDOW) {
        row.skipped = 'counter unavailable in process.memoryUsage()'
      }
    }
    if (!stable) {
      throw new Error(`${phase}: heapUsed/RSS did not settle within 60s`)
    }
  }
  const afterGc = async (phase: Phase): Promise<void> => {
    try {
      const collected = await ctx.launch.app.evaluate(() => {
        if (typeof global.gc !== 'function') {
          return false
        }
        global.gc()
        return true
      })
      if (!collected) {
        skip(phase, 'main global.gc unavailable; no product hook or launch flag added')
        return
      }
      await measure(phase)
    } catch (error) {
      skip(phase, `GC measurement failed: ${String(error).slice(0, 200)}`)
    }
  }
  const delta = (before: Phase, after: Phase, phase: Phase): void => {
    for (const row of groupFor(phase)) {
      const left = groupFor(before).find((value) => value.operation === row.operation)!
      const right = groupFor(after).find((value) => value.operation === row.operation)!
      const a = stat(left.samples.map((sample) => sample.extra?.bytes))
      const b = stat(right.samples.map((sample) => sample.extra?.bytes))
      if (left.skipped || right.skipped || !a || !b) {
        row.skipped = left.skipped ?? right.skipped ?? 'baseline or active counter unavailable'
      } else {
        row.samples.push({
          extra: { bytes: b.p50 - a.p50 },
          evidence: {
            workerInventoriesBefore: left.samples.map((sample) => sample.evidence),
            workerInventoriesAfter: right.samples.map((sample) => sample.evidence)
          }
        })
      }
    }
  }
  const subscriptions = await page(ctx).evaluateHandle(() => {
    const handles: { unsubscribe: () => void }[] = []
    const errors: string[] = []
    return { handles, errors }
  })
  try {
    await measure('before activation')
    await afterGc('before activation post-GC')
    const chats = seededChats(ctx.manifest)
    if (chats.length !== ctx.workload.history.fillerChats + 1) {
      throw new Error('memory seed chat count mismatch')
    }
    for (const [index, sessionId] of chats.entries()) {
      await history(page(ctx), sessionId, 'tail', 1)
      await subscriptions.evaluate(async (state, sessionId) => {
        const handle = await window.api.runtime.subscribe(
          { method: 'agentSession.subscribe', params: { sessionId } },
          (reply) => {
            if (!reply.ok && state.errors.length < 10) {
              state.errors.push(`${sessionId}: ${JSON.stringify(reply.error)}`)
            }
            if (
              reply.ok &&
              typeof reply.result === 'object' &&
              reply.result !== null &&
              'type' in reply.result &&
              reply.result.type === 'end' &&
              state.errors.length < 10
            ) {
              state.errors.push(`${sessionId}: subscription ended before sampling finished`)
            }
          }
        )
        state.handles.push(handle)
      }, sessionId)
      if ((index + 1) % 20 === 0) {
        ctx.log(`${ctx.arm.name}: memory ${index + 1}/${chats.length} subscribed`)
      }
    }
    const checkSubscriptions = async (): Promise<void> => {
      const errors = await subscriptions.evaluate((state) => state.errors)
      if (errors.length > 0) {
        throw new Error(`memory subscription failed: ${errors.join('; ').slice(0, 300)}`)
      }
    }
    await checkSubscriptions()
    await measure('after activation')
    await afterGc('after activation post-GC')
    await checkSubscriptions()
  } catch (error) {
    const reason = `memory measurement failed: ${String(error).slice(0, 250)}`
    for (const phase of PHASES) {
      if (
        phase.startsWith('after') ||
        groupFor(phase).every((row) => row.samples.length === 0 && !row.skipped)
      ) {
        skip(phase, reason)
      }
    }
  } finally {
    await subscriptions
      .evaluate((state) => {
        for (const handle of state.handles) {
          handle.unsubscribe()
        }
        state.handles.length = 0
      })
      .finally(() => subscriptions.dispose())
    delta('before activation', 'after activation', 'activation delta')
    delta('before activation post-GC', 'after activation post-GC', 'activation delta post-GC')
  }
}

export { seedMemoryProfile, convertedMemoryRows } from './native-chat-4a-memory-profile'
