import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import pendingFlush from '../../mobile/src/terminal/terminal-live-pending-flush-state'

const { createTerminalLivePendingFlushState, queueTerminalLiveMirrorSend } = pendingFlush

const RELAY_RTT_MS = 180
const KEY_INTERVAL_MS = 30
const INPUT_DELTA_COUNT = 18
const assertCoalesced = process.argv.includes('--assert-coalesced')
const labelIndex = process.argv.indexOf('--label')
const label = labelIndex >= 0 ? process.argv[labelIndex + 1] : 'latest'
const artifactDir = path.resolve('.tmp/mobile-terminal-relay-input', label ?? 'latest')
const encoder = new TextEncoder()

type ScheduledAck = {
  at: number
  complete: () => void
}

async function flushPromiseReactions(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
  }
}

async function main(): Promise<void> {
  const state = createTerminalLivePendingFlushState()
  const inputTimes = Array.from(
    { length: INPUT_DELTA_COUNT },
    (_, index) => index * KEY_INTERVAL_MS
  )
  const scheduledAcks: ScheduledAck[] = []
  const results: Promise<boolean>[] = []
  const rpcByteLengths: number[] = []
  let now = 0
  let inputIndex = 0
  let inFlightRpcs = 0
  let maxConcurrentRpcs = 0

  const send = (payload: string): Promise<boolean> => {
    rpcByteLengths.push(encoder.encode(payload).byteLength)
    inFlightRpcs += 1
    maxConcurrentRpcs = Math.max(maxConcurrentRpcs, inFlightRpcs)
    return new Promise((resolve) => {
      scheduledAcks.push({
        at: now + RELAY_RTT_MS,
        complete: () => {
          inFlightRpcs -= 1
          resolve(true)
        }
      })
    })
  }

  while (inputIndex < inputTimes.length || scheduledAcks.length > 0) {
    const nextInputAt = inputTimes[inputIndex] ?? Number.POSITIVE_INFINITY
    const nextAckAt = scheduledAcks[0]?.at ?? Number.POSITIVE_INFINITY
    if (nextAckAt <= nextInputAt) {
      now = nextAckAt
      scheduledAcks.shift()?.complete()
      await flushPromiseReactions()
      continue
    }

    now = nextInputAt
    results.push(queueTerminalLiveMirrorSend(state, 'synthetic-terminal', 'x', send))
    inputIndex += 1
  }

  const accepted = await Promise.all(results)
  await flushPromiseReactions()
  const evidence = {
    relayRttMs: RELAY_RTT_MS,
    keyIntervalMs: KEY_INTERVAL_MS,
    inputDeltaCount: INPUT_DELTA_COUNT,
    totalInputBytes: INPUT_DELTA_COUNT,
    serializedRpcCount: INPUT_DELTA_COUNT,
    serializedCompletionMs: INPUT_DELTA_COUNT * RELAY_RTT_MS,
    coalescedRpcCount: rpcByteLengths.length,
    coalescedCompletionMs: now,
    rpcByteLengths,
    maxConcurrentRpcs,
    allAccepted: accepted.every(Boolean),
    queueDrained: state.current === null && state.pending.length === 0
  }

  await mkdir(artifactDir, { recursive: true })
  const evidencePath = path.join(artifactDir, 'evidence.json')
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(evidencePath)

  if (
    assertCoalesced &&
    (evidence.coalescedRpcCount !== 4 ||
      evidence.coalescedCompletionMs !== 720 ||
      evidence.maxConcurrentRpcs !== 1 ||
      !evidence.allAccepted ||
      !evidence.queueDrained)
  ) {
    throw new Error(`unexpected Relay input batching evidence: ${JSON.stringify(evidence)}`)
  }
}

await main()
