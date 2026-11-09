// Deterministic 4a workloads: the retained-history profile, stream shapes and per-row sample counts, identical for both arms.
import providerText from './native-chat-4a-provider-text.cjs'

export type StreamShape = 'blocks' | 'nobreak'

export type StreamCase = {
  tag: string
  bytes: number
  shape: StreamShape
  /** Running-to-completed tool output emitted before the text, when set. */
  toolOutputBytes?: number
}

export type Workload = {
  profile: 'smoke' | 'full'
  /** Warm repeated samples per row; cold rows take `coldSamples` relaunches. */
  samples: number
  coldSamples: number
  history: {
    /** The large retained chat: one recipe turn is 1 prompt + `tools` tool items + 1 reply (+ its turn row). */
    largeTurns: number
    tools: number
    toolOutputBytes: number
    promptBytes: number
    replyBytes: number
    /** Every Nth large-chat turn is sent while active, leaving released queue history for conversion. */
    queuedEvery: number
    fillerChats: number
    fillerTurns: number
  }
  /** Streams are long; `samples` per stream case, separate from the warm row count. */
  stream: { cases: StreamCase[]; chunkBytes: number; intervalMs: number; samples: number }
  /** Released queued sends accumulated before each retained-history checkpoint; the live queue stays `liveQueue`. */
  retained: { checkpoints: number[]; liveQueue: number }
  rewind: { nearTipSamples: number; deepCutTurns: number; deepSamples: number }
  /** Generated only on the M4Air run; smoke keeps the 55k shape off this Mac. */
  conversionSourceBytes: number
}

const MiB = 1024 * 1024

function streamCases(sizes: number[]): StreamCase[] {
  return sizes.flatMap((bytes) => [
    { tag: `blocks-${bytes / MiB}m`, bytes, shape: 'blocks' as const },
    { tag: `nobreak-${bytes / MiB}m`, bytes, shape: 'nobreak' as const },
    {
      tag: `tool-${bytes / MiB}m`,
      bytes: 64 * 1024,
      shape: 'blocks' as const,
      toolOutputBytes: bytes
    }
  ])
}

export const WORKLOADS: Record<Workload['profile'], Workload> = {
  smoke: {
    profile: 'smoke',
    samples: 3,
    coldSamples: 1,
    history: {
      largeTurns: 20,
      tools: 8,
      toolOutputBytes: 2000,
      promptBytes: 300,
      replyBytes: 1500,
      queuedEvery: 10,
      fillerChats: 6,
      fillerTurns: 1
    },
    stream: { cases: streamCases([MiB / 4]), chunkBytes: 16_384, intervalMs: 1, samples: 1 },
    retained: { checkpoints: [0, 20], liveQueue: 2 },
    rewind: { nearTipSamples: 2, deepCutTurns: 5, deepSamples: 1 },
    conversionSourceBytes: 0
  },
  full: {
    profile: 'full',
    samples: 30,
    coldSamples: 5,
    // The established 5000-turn/55000-item recipe plus 309 small chats: the 55k-history/310-chat profile.
    history: {
      largeTurns: 5000,
      tools: 8,
      toolOutputBytes: 2000,
      promptBytes: 300,
      replyBytes: 1500,
      queuedEvery: 10,
      fillerChats: 309,
      fillerTurns: 2
    },
    stream: {
      cases: streamCases([MiB, 8 * MiB, 16 * MiB]),
      chunkBytes: 16_384,
      intervalMs: 2,
      samples: 10
    },
    retained: { checkpoints: [0, 1_000, 10_000], liveQueue: 2 },
    rewind: { nearTipSamples: 10, deepCutTurns: 1000, deepSamples: 3 },
    conversionSourceBytes: 20 * 1024 * MiB
  }
}

export function workloadFor(profile: string, conversionSourceBytes?: number): Workload {
  const workload = WORKLOADS[profile as Workload['profile']]
  if (!workload) {
    throw new Error(`Unknown profile ${profile}; expected ${Object.keys(WORKLOADS).join(', ')}`)
  }
  return conversionSourceBytes === undefined ? workload : { ...workload, conversionSourceBytes }
}

export type HistoryTurn = { prompt: string; queued: boolean }

/** Large-chat recipe turns in send order; each reply ends with a 4A-TAIL marker naming its turn. */
export function* largeHistoryTurns(workload: Workload): Generator<HistoryTurn> {
  const { history } = workload
  for (let turn = 0; turn < history.largeTurns; turn += 1) {
    const op = {
      op: 'history',
      tag: `large-${turn}`,
      tools: history.tools,
      toolOutputBytes: history.toolOutputBytes,
      replyBytes: history.replyBytes
    }
    yield {
      prompt: providerText.formatDirective(op, history.promptBytes),
      queued: history.queuedEvery > 0 && turn % history.queuedEvery === history.queuedEvery - 1
    }
  }
}

export function fillerTurn(chat: number, turn: number, workload: Workload): string {
  const op = {
    op: 'history',
    tag: `filler-${chat}-${turn}`,
    tools: 2,
    toolOutputBytes: 500,
    replyBytes: 400
  }
  return providerText.formatDirective(op, workload.history.promptBytes)
}

/** Expected large-chat rows, so a run can refuse a fixture that did not seed what it claims. */
export function expectedLargeItems(workload: Workload): number {
  return workload.history.largeTurns * (workload.history.tools + 3)
}

/** Per-turn tool output that makes the conversion source reach `conversionSourceBytes` with the same turn count. */
export function conversionToolOutputBytes(workload: Workload): number {
  const { history } = workload
  if (workload.conversionSourceBytes === 0) {
    return history.toolOutputBytes
  }
  return Math.max(
    history.toolOutputBytes,
    Math.ceil(workload.conversionSourceBytes / (history.largeTurns * history.tools))
  )
}

export function streamPrompt(workload: Workload, stream: StreamCase): string {
  return providerText.formatDirective({
    op: 'stream',
    tag: stream.tag,
    bytes: stream.bytes,
    shape: stream.shape,
    chunkBytes: workload.stream.chunkBytes,
    intervalMs: workload.stream.intervalMs,
    ...(stream.toolOutputBytes ? { toolOutputBytes: stream.toolOutputBytes, toolRunMs: 250 } : {})
  })
}

export const holdPrompt = (tag: string, ms: number): string =>
  providerText.formatDirective({ op: 'hold', tag, ms })
export const replyPrompt = (tag: string): string =>
  providerText.formatDirective({ op: 'reply', tag })

/** Generate every byte both arms will receive and digest it; changing a generator changes the dry-run digest. */
export function dryRunWorkload(workload: Workload): Record<string, unknown> {
  const started = performance.now()
  let promptBytes = 0
  let queued = 0
  let turns = 0
  for (const turn of largeHistoryTurns(workload)) {
    promptBytes += Buffer.byteLength(turn.prompt)
    queued += Number(turn.queued)
    turns += 1
    if (providerText.parseDirective(turn.prompt)?.op !== 'history') {
      throw new Error('history directive did not round-trip')
    }
  }
  const streams = workload.stream.cases.map((stream) => {
    const op = providerText.parseDirective(streamPrompt(workload, stream))
    const text = providerText.streamText(op)
    if (text.length !== stream.bytes || !text.startsWith(`4A-FIRST-${stream.tag}`)) {
      throw new Error(`${stream.tag}: generated ${text.length} bytes, expected ${stream.bytes}`)
    }
    const newlines = text.split('\n').length - 1
    return { tag: stream.tag, bytes: text.length, newlines, digest: providerText.digest(text) }
  })
  return {
    profile: workload.profile,
    largeTurns: turns,
    expectedLargeItems: expectedLargeItems(workload),
    queuedHistoryTurns: queued,
    largePromptBytes: promptBytes,
    largeToolOutputBytes: turns * workload.history.tools * workload.history.toolOutputBytes,
    chats: 1 + workload.history.fillerChats,
    fillerPromptDigest: providerText.digest(fillerTurn(0, 0, workload)),
    streams,
    retained: workload.retained,
    rewind: workload.rewind,
    conversion: {
      sourceBytes: workload.conversionSourceBytes,
      toolOutputBytesPerTool: conversionToolOutputBytes(workload)
    },
    generatorMs: Math.round(performance.now() - started)
  }
}
