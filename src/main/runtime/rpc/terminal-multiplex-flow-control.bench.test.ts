import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import {
  TERMINAL_MULTIPLEX_ACK_BATCH_BYTES,
  TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_ACK_TOTAL_INITIAL_WINDOW_BYTES,
  TERMINAL_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES,
  TERMINAL_STREAM_CHUNK_BYTES
} from '../../../shared/terminal-multiplex-flow-control'
import { drainTerminalMultiplexRoundRobin } from './terminal-multiplex-round-robin'

const MIB = 1024 * 1024
const PAYLOAD_BYTES_PER_STREAM = 64 * MIB
const PARSER_PAYLOAD_BYTES_PER_VIEWER = 4 * MIB
const benchEnabled = process.env.ORCA_TERMINAL_PERF_BENCH === '1'

type SimulationResult = {
  throughputMiBPerSecond: number
  perStreamCompletionMs: number[]
  maxInFlightBytes: number
  outputFrames: number
  ackFrames: number
  loopIterations: number
}

type ParserMeasurement = {
  aggregateMiBPerSecond: number
  cpuMs: number
  retainedHeapKiB: number
  xtermWrites: number
}

async function measureHeadlessXtermParsing(viewers: number): Promise<ParserMeasurement> {
  const { Terminal } = await import('@xterm/headless')
  const sample = '\x1b[?25l\x1b[38;5;45mremote output | build | status | 0123456789\x1b[0m\r\n'
  const chunk = sample
    .repeat(Math.ceil(TERMINAL_STREAM_CHUNK_BYTES / sample.length))
    .slice(0, TERMINAL_STREAM_CHUNK_BYTES)
  const terminals = Array.from(
    { length: viewers },
    () => new Terminal({ cols: 120, rows: 40, scrollback: 5_000 })
  )
  const heapBefore = process.memoryUsage().heapUsed
  const cpuBefore = process.cpuUsage()
  const startedAt = performance.now()
  let xtermWrites = 0
  await Promise.all(
    terminals.map(async (terminal) => {
      let remaining = PARSER_PAYLOAD_BYTES_PER_VIEWER
      while (remaining > 0) {
        const data = remaining >= chunk.length ? chunk : chunk.slice(0, remaining)
        xtermWrites += 1
        await new Promise<void>((resolve) => terminal.write(data, resolve))
        remaining -= data.length
      }
    })
  )
  const elapsedMs = performance.now() - startedAt
  const cpu = process.cpuUsage(cpuBefore)
  const heapAfter = process.memoryUsage().heapUsed
  for (const terminal of terminals) {
    terminal.dispose()
  }
  return {
    aggregateMiBPerSecond: (PARSER_PAYLOAD_BYTES_PER_VIEWER * viewers) / MIB / (elapsedMs / 1_000),
    cpuMs: (cpu.user + cpu.system) / 1_000,
    retainedHeapKiB: Math.max(0, heapAfter - heapBefore) / 1_024,
    xtermWrites
  }
}

function simulateParsedCredit(streamCount: number, rttMs: number): SimulationResult {
  const remaining = Array.from({ length: streamCount }, () => PAYLOAD_BYTES_PER_STREAM)
  const inFlight = Array.from({ length: streamCount }, () => 0)
  const windows = Array.from(
    { length: streamCount },
    () => TERMINAL_MULTIPLEX_ACK_STREAM_INITIAL_WINDOW_BYTES
  )
  const streams = Array.from({ length: streamCount }, (_, streamIndex) => ({
    streamId: streamIndex + 1,
    streamIndex
  }))
  const perStreamCompletionMs = Array.from({ length: streamCount }, () => 0)
  const acknowledgements = new Map<number, { streamIndex: number; bytes: number }[]>()
  let totalInFlight = 0
  let totalWindow = TERMINAL_MULTIPLEX_ACK_TOTAL_INITIAL_WINDOW_BYTES
  let maxInFlightBytes = 0
  let outputFrames = 0
  let ackFrames = 0
  let nowMs = 0
  let loopIterations = 0
  let sendCursorStreamId: number | null = null
  while (remaining.some((bytes) => bytes > 0) || totalInFlight > 0) {
    for (const acknowledgement of acknowledgements.get(nowMs) ?? []) {
      inFlight[acknowledgement.streamIndex] -= acknowledgement.bytes
      totalInFlight -= acknowledgement.bytes
      if (
        remaining[acknowledgement.streamIndex] === 0 &&
        inFlight[acknowledgement.streamIndex] === 0
      ) {
        perStreamCompletionMs[acknowledgement.streamIndex] = nowMs
      }
      windows[acknowledgement.streamIndex] = Math.min(
        TERMINAL_MULTIPLEX_ACK_STREAM_MAX_WINDOW_BYTES,
        windows[acknowledgement.streamIndex]! + acknowledgement.bytes
      )
      totalWindow = Math.min(
        TERMINAL_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES,
        totalWindow + acknowledgement.bytes
      )
      ackFrames += Math.ceil(acknowledgement.bytes / TERMINAL_MULTIPLEX_ACK_BATCH_BYTES)
    }
    acknowledgements.delete(nowMs)
    sendCursorStreamId = drainTerminalMultiplexRoundRobin({
      streams,
      cursorStreamId: sendCursorStreamId,
      drainOne: ({ streamIndex }) => {
        if (
          remaining[streamIndex]! <= 0 ||
          inFlight[streamIndex]! >= windows[streamIndex]! ||
          totalInFlight >= totalWindow
        ) {
          return false
        }
        const bytes = Math.min(
          TERMINAL_STREAM_CHUNK_BYTES,
          remaining[streamIndex]!,
          windows[streamIndex]! - inFlight[streamIndex]!,
          totalWindow - totalInFlight
        )
        remaining[streamIndex] -= bytes
        inFlight[streamIndex] += bytes
        totalInFlight += bytes
        outputFrames += 1
        const due = nowMs + rttMs
        const dueAcks = acknowledgements.get(due) ?? []
        const existingAck = dueAcks.find((ack) => ack.streamIndex === streamIndex)
        if (existingAck) {
          existingAck.bytes += bytes
        } else {
          dueAcks.push({ streamIndex, bytes })
        }
        acknowledgements.set(due, dueAcks)
        return true
      }
    })
    maxInFlightBytes = Math.max(maxInFlightBytes, totalInFlight)
    nowMs += 1
    loopIterations += 1
  }
  return {
    throughputMiBPerSecond: (PAYLOAD_BYTES_PER_STREAM * streamCount) / MIB / (nowMs / 1000),
    perStreamCompletionMs,
    maxInFlightBytes,
    outputFrames,
    ackFrames,
    loopIterations
  }
}

describe('terminal multiplex parsed-credit bounds', () => {
  it('keeps aggregate memory bounded and streams fair at 100 ms RTT', () => {
    const result = simulateParsedCredit(8, 100)
    expect(result.maxInFlightBytes).toBeLessThanOrEqual(
      TERMINAL_MULTIPLEX_ACK_TOTAL_MAX_WINDOW_BYTES
    )
    expect(result.throughputMiBPerSecond / 8).toBeGreaterThan(7)
    expect(result.ackFrames).toBeLessThan(result.outputFrames / 3)
    expect(
      Math.max(...result.perStreamCompletionMs) - Math.min(...result.perStreamCompletionMs)
    ).toBeLessThan(200)
  })
})

describe.skipIf(!benchEnabled)('terminal multiplex parsed-credit benchmark', () => {
  it('reports RTT, fairness, protocol allocations, and measured xterm parser cost', async () => {
    const parserMeasurements = new Map<number, ParserMeasurement>()
    for (const viewers of [1, 4, 8]) {
      parserMeasurements.set(viewers, await measureHeadlessXtermParsing(viewers))
    }
    const rows = [1, 20, 100].flatMap((rttMs) =>
      [1, 4, 8].map((viewers) => {
        const startedAt = performance.now()
        const result = simulateParsedCredit(viewers, rttMs)
        const parser = parserMeasurements.get(viewers)!
        return {
          rttMs,
          viewers,
          aggregateMiBps: Number(result.throughputMiBPerSecond.toFixed(1)),
          perViewerMiBps: Number((result.throughputMiBPerSecond / viewers).toFixed(1)),
          schedulerCpuMs: Number((performance.now() - startedAt).toFixed(2)),
          protocolFrameAllocations: result.outputFrames + result.ackFrames,
          loopIterations: result.loopIterations,
          maxInFlightKiB: result.maxInFlightBytes / 1024,
          completionSpreadMs:
            Math.max(...result.perStreamCompletionMs) - Math.min(...result.perStreamCompletionMs),
          measuredParserMiBps: Number(parser.aggregateMiBPerSecond.toFixed(1)),
          parserCpuMs: Number(parser.cpuMs.toFixed(1)),
          parserRetainedHeapKiB: Number(parser.retainedHeapKiB.toFixed(0)),
          xtermWriteAllocations: parser.xtermWrites
        }
      })
    )
    // eslint-disable-next-line no-console -- opt-in benchmark evidence
    console.table(rows)
  })
})
