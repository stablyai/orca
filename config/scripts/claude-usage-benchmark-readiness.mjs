import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { Worker } from 'node:worker_threads'
import { createClaudeBenchmarkStore } from './claude-usage-benchmark-persistence.mjs'

export async function createClaudeBenchmarkSplitWorker(arm) {
  const code = `const { parentPort } = require('node:worker_threads');
    const { performance } = require('node:perf_hooks');
    import(${JSON.stringify(arm.persistence.moduleUrl)}).then((implementation) => {
      parentPort.on('message', async ({id, request}) => {
        const start = performance.now();
        try {
          const result = await implementation.splitCacheFile(request);
          parentPort.postMessage({ id, result, workerMs: performance.now() - start });
        } catch (error) {
          parentPort.postMessage({ id, error: String(error) });
        }
      });
      parentPort.postMessage({ready:true});
    }).catch((error) => { throw error; });`
  const worker = new Worker(code, {
    eval: true,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  const waiting = new Map()
  await new Promise((resolve, reject) => {
    worker.once('error', reject)
    worker.once('message', (message) => {
      assert.equal(message.ready, true)
      resolve()
    })
  })
  worker.on('message', (message) => {
    const pending = waiting.get(message.id)
    if (!pending) {
      return
    }
    waiting.delete(message.id)
    if (message.error) {
      pending.reject(new Error(message.error))
    } else {
      pending.resolve(message)
    }
  })
  worker.on('error', (error) => {
    for (const pending of waiting.values()) {
      pending.reject(error)
    }
    waiting.clear()
  })
  let id = 0
  return {
    split: (request) =>
      new Promise((resolve, reject) => {
        id += 1
        waiting.set(id, { resolve, reject })
        worker.postMessage({ id, request })
      }),
    close: () => worker.terminate(),
    bootstrapSha256Input: code
  }
}

export async function measureClaudeBenchmarkReadiness(arm, cacheFile, options = {}) {
  let workerMs = 0
  let mainResumeAt = null
  let mainParseAndValidationMs = 0
  let parseReportCalls = 0
  let mainJsonParseMs = 0
  let mainWorkerResponseJsonParseMs = 0
  let latestJsonParseMs = 0
  let productionYieldCount = 0
  const validationSegments = []
  let validationResumeAt = null
  const originalImmediate = globalThis.setImmediate
  const originalParse = JSON.parse
  const originalWarn = console.warn
  JSON.parse = (...args) => {
    const started = performance.now()
    const parsed = originalParse(...args)
    latestJsonParseMs = performance.now() - started
    mainJsonParseMs += latestJsonParseMs
    if (mainResumeAt !== null) {
      mainWorkerResponseJsonParseMs = performance.now() - mainResumeAt
    }
    return parsed
  }
  globalThis.setImmediate = (callback, ...args) => {
    const validationYield = validationResumeAt !== null
    if (validationYield) {
      validationSegments.push(performance.now() - validationResumeAt)
      validationResumeAt = null
      productionYieldCount += 1
    }
    return originalImmediate(() => {
      if (validationYield) {
        validationResumeAt = performance.now()
      }
      callback(...args)
    })
  }
  if (options.fallback) {
    console.warn = () => {}
  }
  const split = async (request) => {
    if (options.fallback) {
      throw new Error('Intentional benchmark worker unavailability')
    }
    const reply = await options.worker.split(request)
    workerMs += reply.workerMs
    mainResumeAt = performance.now()
    return reply.result
  }
  const parser =
    arm.mode === 'current'
      ? (text, parsed, verified) => {
          parseReportCalls += 1
          validationResumeAt = performance.now()
          const start = mainResumeAt ?? validationResumeAt
          const result = arm.persistence.module.parseReport(
            text,
            parsed,
            options.repeatMainVerification ? false : verified
          )
          mainParseAndValidationMs +=
            performance.now() - start + (mainResumeAt === null ? latestJsonParseMs : 0)
          if (!(result instanceof Promise)) {
            validationResumeAt = null
          }
          return result
        }
      : undefined
  let store
  const started = performance.now()
  try {
    store = createClaudeBenchmarkStore(arm, cacheFile, split, parser)
    const constructedAt = performance.now()
    if (store.whenLoaded) {
      await store.whenLoaded()
    }
    const readyAt = performance.now()
    if (validationResumeAt !== null) {
      validationSegments.push(readyAt - validationResumeAt)
    }
    validationResumeAt = null
    const state = store.reportState()
    const enabled = state.scanState.enabled
    const output = {
      constructorSyncMs: constructedAt - started,
      whenLoadedMs: readyAt - started,
      workerReadParseVerifyMigrateMs: workerMs,
      mainParseAndValidationMs,
      mainJsonParseMs,
      mainWorkerResponseJsonParseMs,
      maxObservedValidationSegmentMs: Math.max(0, ...validationSegments),
      maxObservedMainSynchronousSegmentMs: Math.max(
        constructedAt - started,
        mainWorkerResponseJsonParseMs,
        mainParseAndValidationMs,
        ...validationSegments
      ),
      productionYieldCount,
      parseReportCalls,
      sessions: state.sessions.length,
      mainRetainedSourceCount: state.processedFiles.length,
      enabled
    }
    await store.flush()
    return { metrics: output, state }
  } finally {
    validationResumeAt = null
    globalThis.setImmediate = originalImmediate
    JSON.parse = originalParse
    console.warn = originalWarn
    if (store) {
      await store.flush()
    }
  }
}
