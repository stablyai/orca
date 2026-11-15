import { constants, createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { tsImport } from 'tsx/esm/api'

const limit = 8 * 1024 * 1024
const [file, ...ids] = process.argv.slice(2)
const pids = ids.map(Number)
let result = { ok: false, reason: 'analysis-unavailable' }
let parser
let input
try {
  if (
    !file ||
    !pids.length ||
    pids.length > 32 ||
    pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
  ) {
    throw new Error('Invalid arguments')
  }
  const signal = AbortSignal.timeout(10_000)
  input = await open(file, constants.O_RDONLY | constants.O_NONBLOCK)
  const stat = await input.stat()
  if (!stat.isFile() || stat.size > limit) {
    throw new Error('Input budget')
  }
  const [{ spawnWorkerThread }, { WorkerThreadRequestQueue }, compiled] = await Promise.all([
    tsImport('../../../../src/main/worker-threads/worker-thread-spawn.ts', import.meta.url),
    tsImport('../../../../src/main/worker-threads/worker-thread-request-queue.ts', import.meta.url),
    build({
      entryPoints: [
        fileURLToPath(
          new URL(
            '../../../../src/main/compositor-diagnostics/compositor-trace-worker-entry.ts',
            import.meta.url
          )
        )
      ],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      logLevel: 'silent'
    })
  ])
  parser = new WorkerThreadRequestQueue({
    factory: () =>
      spawnWorkerThread(compiled.outputFiles[0].text, {
        eval: true,
        workerData: { pids: [...new Set(pids)] },
        resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 }
      }),
    idleTeardownMs: 10_000,
    maxConsecutiveDeaths: 1,
    queueCap: { maxQueuedCalls: 1, describeFull: () => 'Parser busy' },
    awaitRetirement: true,
    createUnavailableError: (message) => new Error(message),
    describeTimeout: () => 'Parser deadline',
    describeExit: () => 'Parser exited',
    describeCrashLoop: () => 'Parser unavailable',
    onUnavailable: () => {}
  })
  let bytes = 0
  const stream = createReadStream(file, {
    fd: input.fd,
    autoClose: false,
    highWaterMark: 64 * 1024,
    signal
  })
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > limit) {
      throw new Error('Input budget')
    }
    const ack = await parser.dispatch((id) => ({ id, chunk }), 1000, signal)
    if (ack.ready !== true) {
      throw new Error('Parser refused')
    }
  }
  const response = await parser.dispatch((id) => ({ id, end: true }), 1000, signal)
  const { id: _id, ...analysis } = response
  result = analysis
} catch {
  // Never echo a path, trace payload or arbitrary parser exception.
} finally {
  parser?.dispose()
  await parser?.retired()
  await input?.close().catch(() => {})
}
process.stdout.write(`${JSON.stringify(result)}\n`)
process.exitCode = result.ok ? 0 : 1
