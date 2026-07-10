import { describe, expect, it } from 'vitest'
import {
  advanceTerminalTailWaitState,
  appendNormalizedToTailBuffer,
  buildPreview,
  computeTerminalTailWaitState,
  tailGainedNewerBlockedReason,
  type TerminalTailWaitState
} from './orca-runtime'

// These tests pin the onPtyData wait-detection memoization: compactly advancing
// anchor-free output must produce byte-for-byte the same waitBlockedAt stamps
// as recomputing the full retained tail on both sides of every chunk.

type RedrawCursor = ReturnType<typeof appendNormalizedToTailBuffer>['redrawCursor']

type TailSim = {
  tailBuffer: string[]
  tailPartialLine: string
  tailRedrawCursor: RedrawCursor
  preview: string
  waitBlockedAt: number | null
  tailWaitState?: TerminalTailWaitState
}

function newSim(): TailSim {
  return {
    tailBuffer: [],
    tailPartialLine: '',
    tailRedrawCursor: null,
    preview: '',
    waitBlockedAt: null
  }
}

type Compute = typeof computeTerminalTailWaitState

// Mirrors the memoized onPtyData tail loop: reuse the cached tail-derived state
// as the previous state; only recompute it on a preview-fallback (empty tail).
function stepMemoized(sim: TailSim, chunk: string, at: number): void {
  const previousWaitState =
    sim.tailWaitState?.fromTail === true
      ? sim.tailWaitState
      : computeTerminalTailWaitState(sim.tailBuffer, sim.tailPartialLine, sim.preview)
  const nextTail = appendNormalizedToTailBuffer(
    sim.tailBuffer,
    sim.tailPartialLine,
    chunk,
    sim.tailRedrawCursor
  )
  const nextWaitState = advanceTerminalTailWaitState(
    previousWaitState,
    nextTail.lines,
    nextTail.partialLine,
    sim.preview,
    chunk
  )
  if (tailGainedNewerBlockedReason(previousWaitState, nextWaitState, chunk)) {
    sim.waitBlockedAt = at
  }
  sim.tailWaitState = nextWaitState
  sim.tailBuffer = nextTail.lines
  sim.tailPartialLine = nextTail.partialLine
  sim.tailRedrawCursor = nextTail.redrawCursor
  sim.preview = buildPreview(nextTail.lines, nextTail.partialLine)
}

// Reference: the pre-memoization behavior — recompute the previous state fresh
// from the current tail on every chunk (no cache).
function stepReference(sim: TailSim, chunk: string, at: number, compute: Compute): void {
  const previousWaitState = compute(sim.tailBuffer, sim.tailPartialLine, sim.preview)
  const nextTail = appendNormalizedToTailBuffer(
    sim.tailBuffer,
    sim.tailPartialLine,
    chunk,
    sim.tailRedrawCursor
  )
  const nextWaitState = compute(nextTail.lines, nextTail.partialLine, sim.preview)
  if (tailGainedNewerBlockedReason(previousWaitState, nextWaitState, chunk)) {
    sim.waitBlockedAt = at
  }
  sim.tailBuffer = nextTail.lines
  sim.tailPartialLine = nextTail.partialLine
  sim.tailRedrawCursor = nextTail.redrawCursor
  sim.preview = buildPreview(nextTail.lines, nextTail.partialLine)
}

function runBoth(chunks: string[]): { memoized: (number | null)[]; reference: (number | null)[] } {
  const memoSim = newSim()
  const refSim = newSim()
  const memoized: (number | null)[] = []
  const reference: (number | null)[] = []
  chunks.forEach((chunk, index) => {
    const at = index + 1
    stepMemoized(memoSim, chunk, at)
    stepReference(refSim, chunk, at, computeTerminalTailWaitState)
    memoized.push(memoSim.waitBlockedAt)
    reference.push(refSim.waitBlockedAt)
  })
  return { memoized, reference }
}

const SCENARIOS: Record<string, string[]> = {
  'plain output never blocks': ['building...\n', 'compiled ok\n', 'watching for changes\n'],
  'blocked prompt in one chunk': ['Update available! Press Enter to continue.\n'],
  'blocked prompt split across chunks': ['Update available!\n', 'Press Enter to continue.\n'],
  'blocked then plain output stays blocked': [
    'Update available! Press Enter to continue.\n',
    'still here\n',
    'more logs\n'
  ],
  'partial lines without newline then completion': [
    'Update ava',
    'ilable! Press Enter ',
    'to continue.\n'
  ],
  'empty and whitespace chunks': ['', '   ', '\n', 'ok\n', ''],
  'ready header after stale blocked prompt': [
    'Update available! Press Enter to continue.\n',
    'OpenAI Codex\n',
    'model: gpt\n',
    'directory: /repo\n'
  ]
}

const BLOCKED_PROMPT_CASES = [
  ['Update available! Press Enter to continue.', 'codex-update-prompt'],
  ['Choose working directory to resume. Press Enter to continue.', 'codex-cwd-prompt'],
  ['Codex just got an upgrade. Press Enter to continue.', 'codex-model-migration-prompt'],
  ['Hooks need review. Press Enter to confirm.', 'codex-hooks-review-prompt'],
  ['Do you trust this workspace directory?', 'codex-trust-workspace'],
  ['Codex permission request. Press Enter to view.', 'codex-interactive-prompt']
] as const

describe('onPtyData tail wait memoization', () => {
  it('computeTerminalTailWaitState reports fromTail and blocked signals', () => {
    const empty = computeTerminalTailWaitState([], '', '')
    expect(empty.fromTail).toBe(false)
    expect(empty.signal).toBeNull()

    const previewOnly = computeTerminalTailWaitState([], '', 'short preview')
    expect(previewOnly.fromTail).toBe(false)
    expect(previewOnly.waitText).toBe('short preview')

    const blockedPreview = computeTerminalTailWaitState(
      [],
      '',
      'Update available! Press Enter to continue.'
    )
    expect(blockedPreview.signal?.reason).toBe('codex-update-prompt')

    const blocked = computeTerminalTailWaitState(
      ['Update available! Press Enter to continue.'],
      '',
      ''
    )
    expect(blocked.fromTail).toBe(true)
    expect(blocked.signal?.reason).toBe('codex-update-prompt')
  })

  for (const [name, chunks] of Object.entries(SCENARIOS)) {
    it(`memoized stamping matches recompute reference: ${name}`, () => {
      const { memoized, reference } = runBoth(chunks)
      expect(memoized).toEqual(reference)
    })
  }

  for (const [prompt, reason] of BLOCKED_PROMPT_CASES) {
    it(`falls back for the ${reason} anchor`, () => {
      const sim = newSim()
      stepMemoized(sim, 'ordinary output\n', 1)
      stepMemoized(sim, `${prompt}\n`, 2)

      expect(sim.tailWaitState?.signal?.reason).toBe(reason)
      expect(sim.waitBlockedAt).toBe(2)
    })
  }

  it('stays equivalent across tail eviction beyond the retained cap', () => {
    const chunks: string[] = []
    for (let i = 0; i < 2600; i += 1) {
      chunks.push(`line ${i} of streaming build output that keeps the tail busy\n`)
    }
    // Introduce a real blocked prompt well past the eviction boundary.
    chunks.push('Update available! Press Enter to continue.\n')
    chunks.push('trailing log after prompt\n')
    const { memoized, reference } = runBoth(chunks)
    expect(memoized).toEqual(reference)
    // The prompt must actually be detected (guards against a vacuous match).
    expect(memoized.at(-1)).not.toBeNull()
  })

  it('recomputes correctly after a transcript prune empties the tail (prune-then-resume)', () => {
    // pruneDisconnectedPtyTranscript empties the tail AND clears tailWaitState;
    // model that here and assert the memoized stamping still tracks a fresh
    // recompute across the reset (a stale cache would desync the first resumed
    // chunk, since the pre-prune tail held a blocked prompt).
    const prune = (sim: TailSim): void => {
      sim.tailBuffer = []
      sim.tailPartialLine = ''
      sim.tailRedrawCursor = null
      sim.preview = ''
      sim.waitBlockedAt = null
      sim.tailWaitState = undefined
    }
    const memoSim = newSim()
    const refSim = newSim()
    const memoOut: (number | null)[] = []
    const refOut: (number | null)[] = []
    let at = 0
    const feed = (chunk: string): void => {
      at += 1
      stepMemoized(memoSim, chunk, at)
      stepReference(refSim, chunk, at, computeTerminalTailWaitState)
      memoOut.push(memoSim.waitBlockedAt)
      refOut.push(refSim.waitBlockedAt)
    }
    // Pre-prune: leave a stale blocked prompt in the tail.
    ;['building\n', 'Update available! Press Enter to continue.\n', 'more log\n'].forEach(feed)
    prune(memoSim)
    prune(refSim)
    // Resume: a fresh blocked prompt must be stamped, not masked by stale cache.
    ;['fresh start\n', 'Update available! Press Enter to continue.\n', 'after\n'].forEach(feed)

    expect(memoOut).toEqual(refOut)
    expect(memoSim.waitBlockedAt).not.toBeNull()
  })

  it('falls back to the authoritative tail when a redraw introduces a prompt', () => {
    const sim = newSim()
    stepMemoized(sim, 'ordinary output', 1)
    stepMemoized(sim, '\rUpdate available! Press Enter to continue.\n', 2)

    expect(sim.tailWaitState?.signal?.reason).toBe('codex-update-prompt')
    expect(sim.waitBlockedAt).toBe(2)
  })

  it('keeps anchor-free streaming output in compact scan state', () => {
    const chunks: string[] = []
    for (let i = 0; i < 500; i += 1) {
      chunks.push(`streaming line ${i}\n`)
    }
    const memoSim = newSim()
    chunks.forEach((chunk, index) => {
      stepMemoized(memoSim, chunk, index + 1)
    })

    expect(memoSim.tailWaitState?.signal).toBeNull()
    expect(memoSim.tailWaitState?.waitText).toBe('')
    const scanTail = memoSim.tailWaitState?.anchorFreeScanTail
    expect(scanTail).toBeDefined()
    expect(scanTail?.length ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(1024)
  })
})
