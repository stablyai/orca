/**
 * Synthetic benchmark for native chat's post-incremental renderer hot paths.
 * Run: pnpm exec tsx config/scripts/native-chat-live-session-benchmark.ts
 *
 * This excludes transcript parsing, IPC/remote latency, React, and DOM work. The
 * 2 KB/message fixtures intentionally stress fallback-key normalization and are
 * not estimates of average production message size or end-to-end frame latency.
 */

import { deepStrictEqual, strictEqual } from 'node:assert'
import { performance } from 'node:perf_hooks'
import type { NativeChatMessage, NativeChatSession } from '../../src/shared/native-chat-types'
import { getVerifiedNativeChatCommands } from '../../src/shared/native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from '../../src/shared/native-chat-command-envelope'
import { prepareNativeChatLiveMessages } from '../../src/renderer/src/components/native-chat/native-chat-live-message-preparation'
import { mergeNativeChatLiveSession } from '../../src/renderer/src/components/native-chat/native-chat-live-status'
import {
  matchingNativeChatUserTexts,
  selectPendingIndicesRepresentedByUserTexts
} from '../../src/renderer/src/components/native-chat/native-chat-pending-occurrence'
import { pendingSendsAsMessages } from '../../src/renderer/src/components/native-chat/native-chat-pending'
import { assembleNativeChatSession } from '../../src/renderer/src/components/native-chat/native-chat-session-assembler'

type Operation = (index: number) => number
type ExpectedChecksum = (iterations: number) => number
type Calibration = { iterations: number; elapsedMs: number; capped: boolean }

const TARGET_SAMPLE_MS = 50
const MAX_ITERATIONS = 16_777_216
const ROUNDS = 10
let checksum = 0
let expectedChecksum = 0
let validatedCases = 0
let cappedCalibrations = 0
let sessionSink: NativeChatSession | null = null
let messageArraySink: NativeChatMessage[] | null = null
let contentSink = ''
let pendingMatchSink: Set<number> | null = null
const benchmarkStartedAt = performance.now()

function proseFixture(count: number, bytes: number, withTurnId: boolean): NativeChatMessage[] {
  const payload = 'Ab Cd  '.repeat(Math.ceil(bytes / 7)).slice(0, bytes)
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
    blocks: [{ type: 'text' as const, text: `${payload}-${index}` }],
    timestamp: index,
    source: 'transcript' as const,
    ...(withTurnId ? { turnId: `turn-${index}` } : {})
  }))
}

function toolFixture(count: number): NativeChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `tool-${index}`,
    role: index % 2 === 0 ? ('assistant' as const) : ('tool' as const),
    blocks:
      index % 2 === 0
        ? [
            {
              type: 'tool-call' as const,
              name: 'read',
              input: { path: `${index}.txt`, context: 'x'.repeat(512) }
            }
          ]
        : [{ type: 'tool-result' as const, output: `result-${index}-${'x'.repeat(512)}` }],
    timestamp: index,
    source: 'transcript' as const
  }))
}

function legacySession(messages: NativeChatMessage[]): NativeChatSession {
  return assembleNativeChatSession({
    sources: { transcript: messages },
    sessionId: 'benchmark',
    agent: 'claude'
  })
}

function legacyMessageUpdateSession(messages: NativeChatMessage[]): NativeChatSession {
  const commandNames = new Set(
    getVerifiedNativeChatCommands('claude').map((command) => command.name)
  )
  return legacySession(surfaceSkillInvocationUserTurns(messages, commandNames))
}

function directMessageUpdateSession(messages: NativeChatMessage[]): NativeChatSession {
  return mergeNativeChatLiveSession({
    messages: prepareNativeChatLiveMessages(messages, 'claude'),
    sessionId: 'benchmark',
    agent: 'claude',
    hookState: null
  })
}

function oldEmptyPending(messages: NativeChatMessage[]): NativeChatMessage[] {
  pendingMatchSink = selectPendingIndicesRepresentedByUserTexts(
    [],
    matchingNativeChatUserTexts(messages)
  )
  return []
}

function blockContent(message: NativeChatMessage): string {
  const block = message.blocks[0]
  if (!block) {
    return ''
  }
  if (block.type === 'text') {
    return block.text
  }
  if (block.type === 'tool-call') {
    return block.name
  }
  if (block.type === 'tool-result') {
    return block.output
  }
  return block.path ?? block.url ?? block.alt ?? ''
}

function messageWeight(message: NativeChatMessage, content: string): number {
  const idTail = message.id.length > 0 ? message.id.charCodeAt(message.id.length - 1) : 0
  const contentTail = content.length > 0 ? content.charCodeAt(content.length - 1) : 0
  return message.id.length + idTail + message.role.charCodeAt(0) + content.length + contentTail
}

function consumeSession(session: NativeChatSession, index: number): number {
  sessionSink = session
  messageArraySink = session.messages
  const message = session.messages[index % session.messages.length]
  if (!message) {
    contentSink = ''
    return session.status.charCodeAt(0)
  }
  contentSink = blockContent(message)
  return session.status.charCodeAt(0) + messageWeight(message, contentSink)
}

function consumePendingOutput(messages: NativeChatMessage[], index: number): number {
  messageArraySink = messages
  return (index % 7) + 1
}

function cyclicChecksum(values: readonly number[], iterations: number): number {
  if (values.length === 0) {
    return 0
  }
  const cycle = values.reduce((sum, value) => sum + value, 0)
  const fullCycles = Math.floor(iterations / values.length)
  let total = cycle * fullCycles
  for (let index = 0; index < iterations % values.length; index += 1) {
    total += values[index]!
  }
  return total
}

function sessionExpectedChecksum(session: NativeChatSession): ExpectedChecksum {
  const statusWeight = session.status.charCodeAt(0)
  const weights = session.messages.map((message) => {
    const content = blockContent(message)
    return messageWeight(message, content)
  })
  return (iterations) => statusWeight * iterations + cyclicChecksum(weights, iterations)
}

function pendingExpectedChecksum(iterations: number): number {
  return cyclicChecksum([1, 2, 3, 4, 5, 6, 7], iterations)
}

function runSample(operation: Operation, expected: ExpectedChecksum, iterations: number): number {
  let sampleChecksum = 0
  const startedAt = performance.now()
  for (let index = 0; index < iterations; index += 1) {
    sampleChecksum += operation(index)
  }
  const elapsedMs = performance.now() - startedAt
  checksum += sampleChecksum
  expectedChecksum += expected(iterations)
  return elapsedMs
}

function median(samples: number[]): number {
  return [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]!
}

function calibrate(operation: Operation, expected: ExpectedChecksum): Calibration {
  let iterations = 1
  let reachedTarget = false
  while (true) {
    const elapsedMs = runSample(operation, expected, iterations)
    if (elapsedMs >= TARGET_SAMPLE_MS) {
      if (reachedTarget) {
        return { iterations, elapsedMs, capped: false }
      }
      reachedTarget = true
      continue
    }
    if (iterations >= MAX_ITERATIONS) {
      return { iterations, elapsedMs, capped: true }
    }
    reachedTarget = false
    iterations = Math.min(iterations * 2, MAX_ITERATIONS)
  }
}

function benchmark(
  name: string,
  baseline: Operation,
  optimized: Operation,
  expected: ExpectedChecksum
): void {
  const baselineValue = baseline(0)
  const optimizedValue = optimized(0)
  strictEqual(optimizedValue, baselineValue, `${name}: timed arms returned different checksums`)
  validatedCases += 1
  const baselineCalibration = calibrate(baseline, expected)
  const optimizedCalibration = calibrate(optimized, expected)
  cappedCalibrations += Number(baselineCalibration.capped) + Number(optimizedCalibration.capped)
  const baselineSamples: number[] = []
  const optimizedSamples: number[] = []
  for (let round = 0; round < ROUNDS; round += 1) {
    if (round % 2 === 0) {
      baselineSamples.push(
        runSample(baseline, expected, baselineCalibration.iterations) /
          baselineCalibration.iterations
      )
      optimizedSamples.push(
        runSample(optimized, expected, optimizedCalibration.iterations) /
          optimizedCalibration.iterations
      )
    } else {
      optimizedSamples.push(
        runSample(optimized, expected, optimizedCalibration.iterations) /
          optimizedCalibration.iterations
      )
      baselineSamples.push(
        runSample(baseline, expected, baselineCalibration.iterations) /
          baselineCalibration.iterations
      )
    }
  }
  const baselineMs = median(baselineSamples)
  const optimizedMs = median(optimizedSamples)
  const speedup = baselineMs / Math.max(optimizedMs, Number.EPSILON)
  console.log(
    `${name}\t${baselineCalibration.iterations}\t${optimizedCalibration.iterations}\t${baselineCalibration.elapsedMs.toFixed(1)}\t${optimizedCalibration.elapsedMs.toFixed(1)}\t${baselineMs.toFixed(6)}\t${optimizedMs.toFixed(6)}\t${speedup.toFixed(1)}x`
  )
}

function benchmarkSessionArms(
  name: string,
  baselineSession: () => NativeChatSession,
  optimizedSession: () => NativeChatSession
): void {
  const expectedSession = baselineSession()
  deepStrictEqual(optimizedSession(), expectedSession, `${name}: session mismatch`)
  const expected = sessionExpectedChecksum(expectedSession)
  benchmark(
    name,
    (index) => consumeSession(baselineSession(), index),
    (index) => consumeSession(optimizedSession(), index),
    expected
  )
}

function benchmarkMessageUpdate(name: string, messages: NativeChatMessage[]): void {
  benchmarkSessionArms(
    name,
    () => legacyMessageUpdateSession(messages),
    () => directMessageUpdateSession(messages)
  )
}

const prose300 = proseFixture(300, 2_048, false)
const fixtures = [
  ['300 x 2KB prose, no turnId', prose300],
  ['300 x 2KB prose, with turnId', proseFixture(300, 2_048, true)],
  ['300 tool-heavy, no turnId', toolFixture(300)],
  ['100 x 2KB prose, no turnId', proseFixture(100, 2_048, false)],
  ['500 x 2KB prose, no turnId', proseFixture(500, 2_048, false)]
] as const

console.log(
  `Node ${process.version}; ${ROUNDS} alternating interleaved median rounds; ${TARGET_SAMPLE_MS} ms calibration target; ${MAX_ITERATIONS} iteration cap`
)
console.log(
  'case\tbaseline iters\toptimized iters\tbaseline cal ms\toptimized cal ms\tbaseline ms/op\toptimized ms/op\tspeedup'
)

for (const [name, messages] of fixtures) {
  benchmarkMessageUpdate(name, messages)
}

benchmarkSessionArms(
  '300 x 2KB status-only frame',
  () => legacySession(prose300),
  () =>
    mergeNativeChatLiveSession({
      messages: prose300,
      sessionId: 'benchmark',
      agent: 'claude',
      hookState: null
    })
)

deepStrictEqual(pendingSendsAsMessages([], prose300), oldEmptyPending(prose300))
benchmark(
  '300 x 2KB empty pending',
  (index) => consumePendingOutput(oldEmptyPending(prose300), index),
  (index) => consumePendingOutput(pendingSendsAsMessages([], prose300), index),
  pendingExpectedChecksum
)

const combinedSessionExpected = sessionExpectedChecksum(legacyMessageUpdateSession(prose300))
benchmark(
  '300 x 2KB combined',
  (index) =>
    consumeSession(legacyMessageUpdateSession(prose300), index) +
    consumePendingOutput(oldEmptyPending(prose300), index),
  (index) =>
    consumeSession(directMessageUpdateSession(prose300), index) +
    consumePendingOutput(pendingSendsAsMessages([], prose300), index),
  (iterations) => combinedSessionExpected(iterations) + pendingExpectedChecksum(iterations)
)

strictEqual(checksum, expectedChecksum, 'benchmark checksum accounting drifted')
strictEqual(sessionSink?.sessionId, 'benchmark', 'session outputs did not escape')
strictEqual(Array.isArray(messageArraySink), true, 'message arrays did not escape')
strictEqual(contentSink.length > 0, true, 'message content did not escape')
strictEqual(pendingMatchSink instanceof Set, true, 'pending baseline scan did not escape')
console.log(
  `validated=${validatedCases} cases, checksum=${checksum}, capped calibrations=${cappedCalibrations}, runtime=${(
    performance.now() - benchmarkStartedAt
  ).toFixed(0)} ms`
)
