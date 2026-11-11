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
    /** The medium chat's turns, same recipe; 0 seeds no medium chat. */
    mediumTurns: number
    tools: number
    toolOutputBytes: number
    promptBytes: number
    replyBytes: number
    /** Every Nth large-chat turn is sent while active, leaving released queue history for conversion. */
    queuedEvery: number
    fillerChats: number
    fillerTurns: number
    /** Only the separate uniform memory recipe overrides the small fillers. */
    fillerTools?: number
    fillerToolOutputBytes?: number
  }
  /** Streams are long; `samples` per stream case, separate from the warm row count. */
  stream: { cases: StreamCase[]; chunkBytes: number; intervalMs: number; samples: number }
  /** Released queued sends accumulated before each retained-history checkpoint; the live queue stays `liveQueue`. */
  retained: { checkpoints: number[]; liveQueue: number }
  rewind: { nearTipSamples: number; deepCutTurns: number; deepSamples: number }
  /** Generated only on the M4Air run; smoke keeps the 55k shape off this Mac. */
  conversionSourceBytes: number
  /** Huge completed tool originals whose heads share one page, one original above the detail reply cap, one oversized message. */
  shapes: { hugeTools: number; hugeToolBytes: number; capToolBytes: number; messageBytes: number }
  /** Interleaved: parallel subagents whose child rows alternate, per turn. Sparse: one subagent's rows under a near-empty root. */
  subagents: {
    interleavedTurns: number
    agents: number
    childrenPerAgent: number
    sparseChildren: number
  }
  /** Large completed rows written then rewound on a disposable chat, an outside reader held for `holdMs`, reclaim watched for `reclaimWaitMs`. */
  maintenance: { debtTools: number; debtToolBytes: number; holdMs: number; reclaimWaitMs: number }
  /** Completed diff originals the seed writes once into the last filler chat, each under the detail reply cap. */
  diffs: { count: number; patchBytes: number }
}

const MiB = 1024 * 1024

const streamCases = (sizes: number[]): StreamCase[] =>
  sizes.flatMap((bytes) => [
    { tag: `blocks-${bytes / MiB}m`, bytes, shape: 'blocks' as const },
    { tag: `nobreak-${bytes / MiB}m`, bytes, shape: 'nobreak' as const },
    {
      tag: `tool-${bytes / MiB}m`,
      bytes: 64 * 1024,
      shape: 'blocks' as const,
      toolOutputBytes: bytes
    }
  ])

export const WORKLOADS: Record<Workload['profile'], Workload> = {
  smoke: {
    profile: 'smoke',
    samples: 3,
    coldSamples: 1,
    history: {
      largeTurns: 20,
      mediumTurns: 5,
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
    conversionSourceBytes: 0,
    shapes: { hugeTools: 3, hugeToolBytes: MiB, capToolBytes: 5 * MiB, messageBytes: 3 * MiB },
    subagents: { interleavedTurns: 2, agents: 2, childrenPerAgent: 30, sparseChildren: 250 },
    maintenance: { debtTools: 4, debtToolBytes: 2 * MiB, holdMs: 10_000, reclaimWaitMs: 150_000 },
    diffs: { count: 2, patchBytes: MiB }
  },
  full: {
    profile: 'full',
    samples: 30,
    coldSamples: 5,
    // The established 5000-turn/55000-item recipe, a 500-turn medium chat and 308 small chats: the 55k-history/310-chat profile.
    history: {
      largeTurns: 5000,
      mediumTurns: 500,
      tools: 8,
      toolOutputBytes: 2000,
      promptBytes: 300,
      replyBytes: 1500,
      queuedEvery: 10,
      fillerChats: 308,
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
    conversionSourceBytes: 20 * 1024 * MiB,
    shapes: { hugeTools: 4, hugeToolBytes: 3 * MiB, capToolBytes: 16 * MiB, messageBytes: 3 * MiB },
    subagents: { interleavedTurns: 20, agents: 2, childrenPerAgent: 40, sparseChildren: 400 },
    // 160 MiB of rows rewound under a held reader passes the candidate's 32,768-frame WAL admission threshold.
    maintenance: { debtTools: 10, debtToolBytes: 16 * MiB, holdMs: 60_000, reclaimWaitMs: 600_000 },
    diffs: { count: 4, patchBytes: 3 * MiB }
  }
}

export function workloadFor(profile: string, conversionSourceBytes?: number): Workload {
  const workload = profile === 'smoke' || profile === 'full' ? WORKLOADS[profile] : undefined
  if (!workload) {
    throw new Error(`Unknown profile ${profile}; expected ${Object.keys(WORKLOADS).join(', ')}`)
  }
  return conversionSourceBytes === undefined ? workload : { ...workload, conversionSourceBytes }
}

export type HistoryTurn = { prompt: string; queued: boolean }

/** A recipe chat's turns in send order; each reply ends with a 4A-TAIL marker naming its chat and turn. */
export function* historyTurns(
  workload: Workload,
  chat: 'large' | 'medium' = 'large'
): Generator<HistoryTurn> {
  const { history } = workload
  const turns = chat === 'large' ? history.largeTurns : history.mediumTurns
  for (let turn = 0; turn < turns; turn += 1) {
    const op = {
      op: 'history',
      tag: `${chat}-${turn}`,
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
    tools: workload.history.fillerTools ?? 2,
    toolOutputBytes: workload.history.fillerToolOutputBytes ?? 500,
    replyBytes: 400
  }
  return providerText.formatDirective(op, workload.history.promptBytes)
}

/** Expected recipe-chat rows, so a run can refuse a fixture that did not seed what it claims. */
export function expectedItems(turns: number, workload: Workload): number {
  return turns * (workload.history.tools + 3)
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

export const toolBurstPrompt = (workload: Workload, tag: string): string =>
  providerText.formatDirective({
    op: 'history',
    tag,
    tools: 8,
    toolIdPrefix: tag,
    toolRunMs: 250,
    toolOutputBytes: workload.history.toolOutputBytes,
    replyBytes: workload.history.replyBytes
  })

export const streamPhaseBytes = (workload: Workload): number[] =>
  workload.profile === 'full' ? [8 * MiB, 16 * MiB] : [128 * 1024]

export const shapesPrompt = (workload: Workload, tag: string): string =>
  providerText.formatDirective({ op: 'shapes', tag, ...workload.shapes })
export const subagentPrompt = (
  workload: Workload,
  tag: string,
  mode: 'interleaved' | 'sparse'
): string => {
  const { agents, childrenPerAgent, sparseChildren } = workload.subagents
  return providerText.formatDirective({
    op: 'subagents',
    tag,
    agents: mode === 'sparse' ? 1 : agents,
    children: mode === 'sparse' ? sparseChildren : childrenPerAgent
  })
}
export const debtPrompt = (workload: Workload, tag: string): string =>
  providerText.formatDirective({
    op: 'history',
    tag,
    tools: workload.maintenance.debtTools,
    toolOutputBytes: workload.maintenance.debtToolBytes,
    replyBytes: 400
  })
/** A known ASCII unified diff of exactly `bytes` bytes; the seed writes it and every arm reads it back. */
export function diffPatch(index: number, bytes: number): { path: string; patch: string } {
  const file = `4a/diff-${index}.txt`
  const lines = [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -0,0 +1 @@'
  ]
  let length = lines.join('\n').length
  for (let line = 0; length < bytes; line += 1) {
    lines.push(`+4A-DIFF-${index} line ${line}`)
    length += lines.at(-1)!.length + 1
  }
  return { path: file, patch: lines.join('\n').slice(0, bytes) }
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
  for (const turn of historyTurns(workload)) {
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
    expectedLargeItems: expectedItems(workload.history.largeTurns, workload),
    expectedMediumItems: expectedItems(workload.history.mediumTurns, workload),
    queuedHistoryTurns: queued,
    largePromptBytes: promptBytes,
    largeToolOutputBytes: turns * workload.history.tools * workload.history.toolOutputBytes,
    chats: 1 + Number(workload.history.mediumTurns > 0) + workload.history.fillerChats,
    mediumPromptDigest: providerText.digest(
      [...historyTurns(workload, 'medium')].map((turn) => turn.prompt).join('\n')
    ),
    fillerPromptDigest: providerText.digest(fillerTurn(0, 0, workload)),
    streams,
    streamContention: {
      thresholds: streamPhaseBytes(workload),
      streamBytes: streamPhaseBytes(workload).map((bytes) => bytes + MiB),
      operations: 'competing send, large tail read and Stop at observed current text size',
      observationEveryMs: 100
    },
    liveToolBurst: {
      tools: 8,
      promptDigest: providerText.digest(toolBurstPrompt(workload, 'burst'))
    },
    outlineCache: [
      'observed source-key miss',
      'confirmed persisted hit',
      'invalidation after real send'
    ],
    forkPressure: {
      unrelatedRetiredRows: expectedItems(workload.history.largeTurns, workload),
      preparation: 'stopped profile copy; original restored after pressure case',
      concurrent: 'other-chat send',
      peaks: 'WAL and file bytes'
    },
    shapesPromptDigest: providerText.digest(shapesPrompt(workload, 'shapes')),
    subagentPromptDigests: (['interleaved', 'sparse'] as const).map((mode) =>
      providerText.digest(subagentPrompt(workload, 'subagents', mode))
    ),
    debtPromptDigest: providerText.digest(debtPrompt(workload, 'debt')),
    shapes: workload.shapes,
    subagents: workload.subagents,
    maintenance: workload.maintenance,
    diffs: workload.diffs,
    diffPatchDigests: Array.from({ length: workload.diffs.count }, (_, index) =>
      providerText.digest(diffPatch(index, workload.diffs.patchBytes).patch)
    ),
    retained: workload.retained,
    rewind: workload.rewind,
    conversion: {
      sourceBytes: workload.conversionSourceBytes,
      toolOutputBytesPerTool: conversionToolOutputBytes(workload)
    },
    generatorMs: Math.round(performance.now() - started)
  }
}
