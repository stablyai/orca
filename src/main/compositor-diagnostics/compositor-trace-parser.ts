import { StringDecoder } from 'node:string_decoder'
import { threadCpuUsage } from 'node:process'
import { FlexAssembler, arrayRule, objectRule } from 'stream-json/core/utils/flex-assembler.js'
import { createJsonTokenReader } from '../../shared/json-stream/json-token-reader'
import {
  emptyCompositorObservation,
  type CompositorTraceObservation,
  type CompositorTraceResult
} from './compositor-trace-observations'

type TraceEvent = {
  name?: unknown
  cat?: unknown
  ph?: unknown
  pid?: unknown
  tid?: unknown
  dur?: unknown
  tdur?: unknown
  args?: { name?: unknown; draw_result?: unknown }
}

function isTraceEvent(value: unknown): value is TraceEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (!('args' in value) ||
      value.args === undefined ||
      (typeof value.args === 'object' && value.args !== null))
  )
}

export function createCompositorTraceParser(pids: readonly number[]): {
  write: (chunk: Uint8Array) => void
  finish: () => CompositorTraceResult
} {
  const start = threadCpuUsage()
  const cpuMicros = (): number => {
    const usage = threadCpuUsage(start)
    return usage.user + usage.system
  }
  const observations = new Map(
    pids.slice(0, 32).map((pid) => [pid, emptyCompositorObservation(pid)])
  )
  const threads = new Map<
    string,
    { pid: number; compositor: boolean; slices: number; wall: number; cpu: number; timed: boolean }
  >()
  let bytes = 0
  let arrays = 0
  let depth = 0
  const collect = (value: unknown): void => {
    if (!isTraceEvent(value)) {
      throw new Error('Invalid event')
    }
    const event = value
    const row = typeof event.pid === 'number' ? observations.get(event.pid) : undefined
    if (!row) {
      return
    }
    if (typeof event.tid !== 'number' || !Number.isSafeInteger(event.tid)) {
      throw new Error('Missing thread identity')
    }
    const key = `${row.pid}:${event.tid}`
    let thread = threads.get(key)
    if (!thread) {
      if (threads.size >= 4096) {
        throw new Error('Thread budget')
      }
      thread = { pid: row.pid, compositor: false, slices: 0, wall: 0, cpu: 0, timed: true }
      threads.set(key, thread)
    }
    if (event.ph === 'M' && event.name === 'thread_name' && event.args?.name === 'Compositor') {
      thread.compositor = true
    }
    if (event.ph === 'X' && event.name === 'LayerTreeHostImpl::CalculateRenderPasses') {
      row.renderPassAttempts++
      // Chromium 150 DrawResult::kSuccess is 1; a calculation can still precede an aborted draw.
      if (event.args?.draw_result === 1) {
        row.calculationSuccesses++
      } else if (typeof event.args?.draw_result === 'number' && event.args.draw_result > 1) {
        row.calculationAborts++
      } else {
        row.calculationUnknown++
      }
    }
    if (
      event.ph === 'X' &&
      event.name === 'LayerTreeHostImpl::CalculateRenderPasses::EmptyDamageRect'
    ) {
      row.emptyDamage++
    }
    if (event.cat === 'cc,benchmark' && typeof event.name === 'string') {
      if (event.name === 'Frame') {
        row.exactFrameProxyEvents++
      }
      if (['Frame', 'Frame ', 'Frame   '].includes(event.name)) {
        if (event.ph === 'b') {
          row.frameProxyBegins++
        } else if (event.ph === 'e') {
          row.frameProxyEnds++
        }
      }
    }
    if (
      event.ph === 'X' &&
      typeof event.name === 'string' &&
      event.name.includes('cc::Scheduler::FinishImplFrame')
    ) {
      if (typeof event.dur !== 'number' || !Number.isFinite(event.dur) || event.dur < 0) {
        throw new Error('Invalid duration')
      }
      thread.slices++
      thread.wall += event.dur / 1000
      if (typeof event.tdur !== 'number' || !Number.isFinite(event.tdur) || event.tdur < 0) {
        thread.timed = false
      } else {
        thread.cpu += event.tdur / 1000
      }
    }
  }
  const retain = (path: (string | number)[]): boolean => {
    if (path[0] !== 'traceEvents') {
      return false
    }
    if (path.length <= 2) {
      return true
    }
    if (path.length === 3) {
      return ['name', 'cat', 'ph', 'pid', 'tid', 'dur', 'tdur', 'args'].includes(String(path[2]))
    }
    return (
      path.length === 4 && path[2] === 'args' && ['name', 'draw_result'].includes(String(path[3]))
    )
  }
  const discard = {
    filter: (path: (string | number)[]) => !retain(path),
    create: () => null,
    add: () => {}
  }
  const assembler = new FlexAssembler({
    maxDepth: 16,
    objectRules: [
      objectRule({ filter: (path) => path.length === 0, create: () => null, add: () => {} }),
      discard
    ],
    arrayRules: [
      arrayRule({
        filter: (path) => path.length === 1 && path[0] === 'traceEvents',
        create: () => {
          if (++arrays > 1) {
            throw new Error('Duplicate traceEvents')
          }
          return null
        },
        add: (_target, value) => collect(value)
      }),
      discard
    ]
  })
  const reader = createJsonTokenReader(
    (token) => {
      if (token.name === 'startObject' || token.name === 'startArray') {
        if (++depth > 16) {
          throw new Error('Depth budget')
        }
      } else if (token.name === 'endObject' || token.name === 'endArray') {
        depth--
      }
      if ('value' in token && typeof token.value === 'string' && token.value.length > 256) {
        throw new Error('Scalar budget')
      }
      assembler.consume(token)
    },
    16 * 1024,
    () => {
      const key = assembler.isArray ? assembler.arrayIndex + 1 : assembler.key
      return key !== null && retain([...assembler.path, key])
    }
  )
  const decoder = new StringDecoder('utf8')
  return {
    write(chunk) {
      bytes += chunk.byteLength
      if (bytes > 8 * 1024 * 1024 || cpuMicros() > 100_000) {
        throw new Error('Parser budget')
      }
      reader.write(decoder.write(Buffer.from(chunk)))
    },
    finish() {
      reader.write(decoder.end())
      reader.end()
      if (arrays !== 1 || depth !== 0) {
        return { ok: false, reason: 'trace-invalid' }
      }
      const missingTiming = new Set<number>()
      for (const thread of threads.values()) {
        const row = observations.get(thread.pid)
        if (row && thread.compositor) {
          row.compositorThreadCoverage = 'identified'
          row.finishImplFrameSlices = (row.finishImplFrameSlices ?? 0) + thread.slices
          row.finishImplFrameWallMs = (row.finishImplFrameWallMs ?? 0) + thread.wall
          row.finishImplFrameThreadMs = (row.finishImplFrameThreadMs ?? 0) + thread.cpu
          if (!thread.timed) {
            missingTiming.add(row.pid)
          }
        }
      }
      const rows: CompositorTraceObservation[] = [...observations.values()]
      for (const row of rows) {
        if (missingTiming.has(row.pid)) {
          row.finishImplFrameThreadMs = null
        }
        if (row.frameProxyBegins > 0 || row.frameProxyEnds > 0) {
          row.classification = 'proxy-progress-observed'
        }
      }
      const cpu = cpuMicros()
      return cpu > 100_000
        ? { ok: false, reason: 'parser-budget' }
        : { ok: true, observations: rows, cpuMicros: cpu }
    }
  }
}
