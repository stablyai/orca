import { TerminalSnapshotState } from '../../shared/terminal-snapshot-state'
import { TerminalSnapshotObserver } from '../../shared/terminal-snapshot-observer'
import { readFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeConstructionDependencies } from './construction/runtime-construction-dependencies'
import type { RuntimeTerminalAgentStatusEvent } from './runtime-terminal-contracts'
import type {
  RuntimePtyWorktreeRecord,
  RuntimePtyTitleTrackerEntry
} from './runtime-terminal-state-records'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import type {
  TerminalTransientObservation,
  TerminalTransientSink
} from '../../shared/terminal-transient-observation'
import { DaemonStreamDataBatcher } from '../daemon/daemon-stream-data-batcher'
import { DaemonTransientReader } from '../daemon/daemon-transient-reader'
import {
  readTimedRuntimeFixture,
  splitTranscriptIntoChunks
} from './agent-transcript-replay-test-harness'

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `tab-1:${LEAF_ID}`

class MeasuredRuntime extends OrcaRuntimeService {
  get measuredPtys() {
    return this.ptysById
  }
  get measuredTitleTrackers() {
    return this.ptyTitleTrackersByPtyId
  }
}

function createRuntime(deps: RuntimeConstructionDependencies = {}): {
  runtime: MeasuredRuntime
  statuses: RuntimeTerminalAgentStatusEvent[]
  channelOrder: string[]
  batches: TerminalSideEffectBatch[]
} {
  const statuses: RuntimeTerminalAgentStatusEvent[] = []
  const channelOrder: string[] = []
  const batches: TerminalSideEffectBatch[] = []
  const runtime = new MeasuredRuntime(undefined, undefined, {
    onTerminalAgentStatus: (event) => {
      statuses.push(event)
      channelOrder.push(`status:${event.payload.state}`)
    },
    onTerminalSideEffects: (batch) => {
      batches.push(batch)
      channelOrder.push(...batch.facts.map((fact) => `fact:${fact.kind}`))
    },
    ...deps
  })
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'opencode'
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      { tabId: 'tab-1', worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: 'pty-1' }
    ]
  })
  return { runtime, statuses, channelOrder, batches }
}

const summary = (statuses: RuntimeTerminalAgentStatusEvent[]): string[] =>
  statuses.map(
    (event) =>
      `${event.paneKey}:${event.payload.state}${event.payload.interrupted ? ':interrupted' : ''}:${event.origin}`
  )

const readV1Capture = (name: string): string =>
  readFileSync(
    new URL(`../daemon/__fixtures__/pty-transcripts/${name}.txt`, import.meta.url),
    'utf8'
  )

const titleFacts = (batches: TerminalSideEffectBatch[]) =>
  batches.flatMap((batch) => batch.facts.filter((fact) => fact.kind === 'title'))

function recordedTitlePair() {
  const titles = Array.from(
    // eslint-disable-next-line no-control-regex -- Original OSC titles are delimited by ESC and BEL.
    readV1Capture('opencode').matchAll(/\x1b\]0;[^\x07]*\x07/g),
    ([chunk]) => chunk
  )
  const first = titles[2]
  const later = titles[3]
  if (!first || !later) {
    throw new Error('Missing original OpenCode title reads')
  }
  return [first, later] as const
}

function recordedReplay(mode: 'raw' | 'snapshot') {
  const retire = vi.fn()
  const capture = vi.fn(() => retire)
  // Controlled current launch/live hook context; neither comes from the PTY recording.
  const presence = vi.fn(async () => 'live' as const)
  const fixture = createRuntime({
    captureAgentHookCompatibilityRetirement: capture,
    checkHookAgentPresence: presence
  })
  const { runtime } = fixture
  runtime.registerPty('pty-1', WORKTREE_ID, null, {
    tabId: 'tab-1',
    leafId: LEAF_ID,
    incarnationId: 'recorded-replay',
    agentLaunchAuthority: { launchToken: 'controlled-launch', launchAgent: 'opencode' }
  })
  const ptys: ReadonlyMap<string, RuntimePtyWorktreeRecord> = runtime.measuredPtys
  const observer = new TerminalSnapshotObserver((observation) =>
    runtime.applyTerminalTransientObservation('pty-1', 'recorded-replay', observation)
  )
  if (mode === 'snapshot') {
    runtime.applyTerminalTransientObservation('pty-1', 'recorded-replay', observer.snapshot())
  }
  let sequence = 0
  return {
    ...fixture,
    pty: ptys.get('pty-1'),
    capture,
    retire,
    presence,
    feed(chunk: string) {
      sequence = runtime.onPtyData('pty-1', chunk, Date.now())
      if (mode === 'snapshot') {
        observer.observe(chunk, sequence)
      }
    },
    dispose() {
      observer.dispose()
      runtime.onPtyExit('pty-1', 0)
    }
  }
}

describe('generic terminal observation authority', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  it('applies the full genuine v1 recording at one tick through raw, snapshot and coalesced reads', () => {
    vi.setSystemTime(1000)
    const recording = readV1Capture('opencode')
    const finalTitle = 'OC | CJK words emoji meanings table'
    for (const route of ['raw', 'snapshot', 'coalesced'] as const) {
      const replay = recordedReplay(route === 'raw' ? 'raw' : 'snapshot')
      try {
        for (const chunk of route === 'coalesced'
          ? [recording]
          : splitTranscriptIntoChunks(recording)) {
          replay.feed(chunk)
        }
        expect(
          replay.runtime.getTerminalSideEffectSnapshot('pty-1')?.terminalState?.snapshot.current
            .title?.rawTitle,
          route
        ).toBe(finalTitle)
        expect(replay.pty?.lastOscTitle, route).toBe(finalTitle)
        expect(titleFacts(replay.batches).at(-1), route).toEqual({
          kind: 'title',
          rawTitle: finalTitle,
          normalizedTitle: finalTitle,
          ...(route === 'raw' ? {} : { observedAt: 1000 })
        })
        expect(replay.retire).not.toHaveBeenCalled()
        expect(replay.pty?.launchToken).toBe('controlled-launch')
      } finally {
        replay.dispose()
      }
    }
  })

  it('delivers same-clock install A/live B through the actual daemon batch, then live A once', () => {
    vi.setSystemTime(1000)
    const replay = recordedReplay('raw')
    const [first, later] = recordedTitlePair()
    const delivered: TerminalTransientObservation[] = []
    const reader = new DaemonTransientReader((event) => {
      if (event.event === 'terminalObservation') {
        delivered.push(event.payload)
        replay.runtime.applyTerminalTransientObservation(
          'pty-1',
          event.incarnationId,
          event.payload
        )
      }
    })
    const socket = new Socket()
    vi.spyOn(socket, 'write').mockImplementation((...args: unknown[]) => {
      for (const line of String(args[0]).trim().split('\n')) {
        if (line) {
          reader.accept(JSON.parse(line))
        }
      }
      return true
    })
    const batcher = new DaemonStreamDataBatcher(() => ({
      streamSocket: socket,
      streamFraming: 'ndjson'
    }))
    let sink: TerminalTransientSink | undefined
    const observer = new TerminalSnapshotObserver((observation) => {
      sink?.stage(observation)
      sink?.commit()
    })
    try {
      observer.observe(first, first.length)
      sink = batcher.bindTransients('client', 'pty-1')
      if (!sink) {
        throw new Error('Expected a live daemon transient sink')
      }
      sink.install(observer.snapshot(), 'recorded-replay', () => observer.snapshot())
      observer.observe(later, first.length + later.length)
      expect(replay.batches).toEqual([])
      batcher.flush('client')
      const a = { rawTitle: 'OpenCode', normalizedTitle: 'OpenCode', observedAt: 1000 }
      const b = {
        ...a,
        rawTitle: 'OC | CJK words emoji meanings table',
        normalizedTitle: 'OC | CJK words emoji meanings table'
      }
      const factA = { kind: 'title', ...a }
      const factB = { kind: 'title', ...b }
      expect(
        delivered.map((state) => ({ revision: state.revision, title: state.current.title }))
      ).toEqual([
        { revision: 1, title: a },
        { revision: 2, title: b }
      ])
      expect(
        replay.batches.map((batch) => ({ replay: batch.replay === true, facts: batch.facts }))
      ).toEqual([
        { replay: true, facts: [factA] },
        { replay: false, facts: [factB] }
      ])
      expect(replay.pty?.lastOscTitle).toBe(b.rawTitle)
      expect(
        replay.runtime.getTerminalSideEffectSnapshot('pty-1')?.terminalState?.snapshot.current.title
      ).toEqual(delivered[1]?.current.title)
      expect(observer.snapshot().current.title).toMatchObject(b)
      observer.observe(first, first.length * 2 + later.length)
      batcher.flush('client')
      expect(titleFacts(replay.batches)).toEqual([factA, factB, factA])
      expect(replay.pty?.lastOscTitle).toBe(a.rawTitle)
      for (const state of [delivered[2], delivered[0]]) {
        if (!state) {
          throw new Error('Expected delivered daemon observations')
        }
        replay.runtime.applyTerminalTransientObservation('pty-1', 'recorded-replay', state)
      }
      expect(titleFacts(replay.batches)).toEqual([factA, factB, factA])
      expect(replay.statuses).toEqual([])
      expect(replay.capture).not.toHaveBeenCalled()
      expect(replay.pty?.launchToken).toBe('controlled-launch')
    } finally {
      sink?.dispose?.()
      batcher.clear()
      reader.dispose()
      socket.destroy()
      observer.dispose()
      replay.dispose()
    }
  })

  it('compares source title content, provenance, freshness and null without reviving policy-cleared state', () => {
    const replay = recordedReplay('raw')
    const source = new TerminalSnapshotState()
    const title = { kind: 'title', rawTitle: 'OpenCode', normalizedTitle: 'OpenCode' } as const
    const apply = () =>
      replay.runtime.applyTerminalTransientObservation(
        'pty-1',
        'recorded-replay',
        source.snapshot()
      )
    try {
      source.record(title, 1000)
      source.record({ kind: 'bell' }, 1000)
      apply()
      expect(titleFacts(replay.batches)).toEqual([{ ...title, observedAt: 1000 }])
      expect(replay.channelOrder).not.toContain('fact:bell')
      source.record(title, 1000)
      apply()
      expect(titleFacts(replay.batches)).toHaveLength(1)
      const entries: ReadonlyMap<string, RuntimePtyTitleTrackerEntry> =
        replay.runtime.measuredTitleTrackers
      const entry = entries.get('pty-1')
      if (!entry?.sideEffectState) {
        throw new Error('Expected installed runtime policy state')
      }
      // Controlled policy divergence; admitted source title stays untouched.
      entry.sideEffectState.state.current.title = null
      source.record({ kind: 'bell' }, 1001)
      apply()
      expect(entry.sideEffectState.snapshot().current.title).toBeNull()
      expect(titleFacts(replay.batches)).toHaveLength(1)
      expect(replay.channelOrder.filter((kind) => kind === 'fact:bell')).toHaveLength(1)
      source.record(title, 1001)
      apply()
      expect(replay.pty?.lastOscTitleEpochMs).toBe(1001)
      expect(titleFacts(replay.batches).at(-1)).toEqual({ ...title, observedAt: 1001 })
      const normalized = { ...title, normalizedTitle: 'Normalized OpenCode' }
      source.record(normalized, 1001)
      apply()
      expect(replay.pty?.lastOscTitle).toBe(normalized.normalizedTitle)
      expect(entry.lastTitle).toEqual({
        raw: title.rawTitle,
        normalized: normalized.normalizedTitle
      })
      expect(titleFacts(replay.batches).at(-1)).toEqual({ ...normalized, observedAt: 1001 })
      source.record({ ...normalized, staleWorkingTitleClear: true }, 1001)
      apply()
      expect(replay.pty?.titleDisplayClear?.title).toBe(normalized.normalizedTitle)
      expect(titleFacts(replay.batches).at(-1)).toEqual({
        ...normalized,
        staleWorkingTitleClear: true,
        observedAt: 1001
      })
      source.record(normalized, 1001)
      apply()
      expect(replay.pty?.titleDisplayClear).toBeNull()
      expect(titleFacts(replay.batches).at(-1)).toEqual({ ...normalized, observedAt: 1001 })
      const beforeNull = titleFacts(replay.batches).length
      source.state.current.title = null
      source.state.revision++
      apply()
      expect(entry.sideEffectState.snapshot().current.title).toBeNull()
      expect(entry.tracker.getLastNormalizedTitle()).toBeNull()
      expect(titleFacts(replay.batches)).toHaveLength(beforeNull)
      source.record(normalized, 1001)
      apply()
      expect(titleFacts(replay.batches)).toHaveLength(beforeNull + 1)
      apply()
      expect(titleFacts(replay.batches)).toHaveLength(beforeNull + 1)
      expect(replay.statuses).toEqual([])
    } finally {
      replay.dispose()
    }
  })

  it('keeps installed observations authoritative across a display gap and later visibility marker', async () => {
    const { runtime, statuses, channelOrder } = createRuntime()
    const source = new TerminalSnapshotState()
    runtime.applyTerminalTransientObservation('pty-1', 'incarnation', source.snapshot())
    expect(statuses).toEqual([])
    expect(channelOrder).toEqual([])
    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    source.record({ kind: 'command-started' }, 100)
    source.record(
      {
        kind: 'agent-status',
        payload: { state: 'working', prompt: '', agentType: 'opencode' }
      },
      101
    )
    runtime.applyTerminalTransientObservation('pty-1', 'incarnation', source.snapshot())
    runtime.notePtyDataGap('pty-1', 1000)
    runtime.setPtyTransientFactDelegation('pty-1', false)
    runtime.onPtyData('pty-1', '\x1b]133;D;0\x07\x1b]133;A\x07', 101)
    expect(summary(statuses)).toEqual([`${PANE_KEY}:working:undefined`])
    source.record({ kind: 'command-finished', exitCode: 0 }, 102)
    source.record(
      {
        kind: 'agent-status',
        payload: { state: 'done', prompt: '', agentType: 'opencode' }
      },
      103
    )
    runtime.applyTerminalTransientObservation('pty-1', 'incarnation', source.snapshot())
    expect(summary(statuses)).toEqual([
      `${PANE_KEY}:working:undefined`,
      `${PANE_KEY}:done:undefined`
    ])
    expect(channelOrder).toEqual([
      'fact:command-started',
      'status:working',
      'fact:agent-status',
      'fact:command-finished',
      'status:done',
      'fact:agent-status'
    ])
  })

  it('keeps projection counters continuous through an actual provider source replacement and rollback', () => {
    const { runtime, channelOrder } = createRuntime()
    const first = new TerminalSnapshotState()
    const capable = { provider: {}, stream: {}, terminalState: true }
    runtime.applyTerminalTransientObservation('pty-1', 'physical', first.snapshot(), capable)
    first.record({ kind: 'bell' }, 10)
    runtime.applyTerminalTransientObservation('pty-1', 'physical', first.snapshot(), capable)
    const before = runtime.getTerminalSideEffectSnapshot('pty-1')?.terminalState?.snapshot
    expect(before?.effects.bell?.count).toBe(1)
    const legacy = { provider: {}, stream: {}, terminalState: false }
    runtime.selectPtyLegacySemanticSource('pty-1', legacy)
    runtime.onPtyData('pty-1', '\x07', 20)
    expect(channelOrder.filter((kind) => kind === 'fact:bell')).toHaveLength(2)
    const replacement = new TerminalSnapshotState()
    replacement.record({ kind: 'bell' }, 30)
    const newSource = { provider: legacy.provider, stream: {}, terminalState: true }
    runtime.applyTerminalTransientObservation(
      'pty-1',
      'physical',
      replacement.snapshot(),
      newSource
    )
    expect(channelOrder.filter((kind) => kind === 'fact:bell')).toHaveLength(2)
    replacement.record({ kind: 'bell' }, 40)
    runtime.applyTerminalTransientObservation(
      'pty-1',
      'physical',
      replacement.snapshot(),
      newSource
    )
    const after = runtime.getTerminalSideEffectSnapshot('pty-1')?.terminalState?.snapshot
    expect(after?.effects.bell?.count).toBe(3)
    expect(channelOrder.filter((kind) => kind === 'fact:bell')).toHaveLength(3)
    runtime.onPtyExit('pty-1', 0)
  })

  it('does not synthesize a status for an exited one-shot command', async () => {
    const { runtime, statuses, channelOrder } = createRuntime()
    runtime.onPtyData('pty-1', '\x1b]133;C\x07', 100)
    await vi.advanceTimersByTimeAsync(5000)
    runtime.onPtyData('pty-1', 'done\x1b]133;D;0\x07', 101)
    await vi.advanceTimersByTimeAsync(5000)
    expect(statuses).toEqual([])
    expect(channelOrder).toEqual(['fact:command-started', 'fact:command-finished'])
  })

  it('does not fabricate Working or Done from the recorded v1 one-shot result', async () => {
    // v1.18.32 capture metadata records exit 0; shell marks below are controlled context.
    const chunks = splitTranscriptIntoChunks(readV1Capture('opencode-run'))
    for (const mode of ['raw', 'snapshot'] as const) {
      const replay = recordedReplay(mode)
      try {
        replay.feed('\x1b]133;C\x07')
        for (const chunk of chunks) {
          replay.feed(chunk)
        }
        await vi.advanceTimersByTimeAsync(5000)
        expect(replay.statuses).toEqual([])
        expect(replay.channelOrder).toEqual(['fact:command-started'])
        expect(replay.capture).not.toHaveBeenCalled()
        replay.feed('\x1b]133;D;0\x07')
        await vi.advanceTimersByTimeAsync(5000)
        expect(replay.statuses).toEqual([])
        expect(replay.channelOrder).toEqual(['fact:command-started', 'fact:command-finished'])
        expect(replay.capture).toHaveBeenCalledWith(PANE_KEY)
        expect(replay.retire).not.toHaveBeenCalled()
      } finally {
        replay.dispose()
      }
    }
  })

  it.each(['v1', 'v2'] as const)(
    'keeps current launch authority through the recorded %s interactive reply/title',
    async (version) => {
      // v1 uses synthetic 64-char/1ms reads; v2 preserves recorded reads, timing and silence.
      const timed =
        version === 'v2'
          ? readTimedRuntimeFixture('opencode-2-0-21-timed-enter-after-agent-row')
          : undefined
      const chunks = timed?.chunks ?? splitTranscriptIntoChunks(readV1Capture('opencode'))
      const title =
        version === 'v1' ? 'OC | CJK words emoji meanings table' : 'OC | Orca readiness capture'
      for (const mode of ['raw', 'snapshot'] as const) {
        const replay = recordedReplay(mode)
        try {
          let elapsed = 0
          for (const [index, chunk] of chunks.entries()) {
            if (timed) {
              await vi.advanceTimersByTimeAsync(timed.times[index] - elapsed)
              elapsed = timed.times[index]
            } else {
              await vi.advanceTimersByTimeAsync(1)
            }
            replay.feed(chunk)
          }
          if (timed?.recordedUntilMs !== undefined) {
            await vi.advanceTimersByTimeAsync(timed.recordedUntilMs - elapsed)
          }
          const snapshot = replay.runtime.getTerminalSideEffectSnapshot('pty-1')
          expect(snapshot?.terminalState?.snapshot.current.title?.rawTitle, mode).toBe(title)
          expect(snapshot?.seq).toBe(chunks.join('').length)
          expect(replay.channelOrder).toContain('fact:title')
          expect(replay.channelOrder).not.toContain('fact:command-finished')
          expect(replay.channelOrder).not.toContain('fact:agent-exited')
          expect(replay.capture).not.toHaveBeenCalled()
          expect(replay.pty).toMatchObject({
            connected: true,
            incarnationId: 'recorded-replay',
            launchToken: 'controlled-launch',
            launchAgent: 'opencode'
          })
          // A synthetic shell boundary probes retirement with explicitly live process evidence.
          replay.feed('\x1b]133;C\x07\x1b]133;D;0\x07')
          await vi.advanceTimersByTimeAsync(5000)
          expect(replay.capture).toHaveBeenCalledTimes(1)
          expect(replay.presence).toHaveBeenCalledWith(PANE_KEY)
          expect(replay.retire).not.toHaveBeenCalled()
          expect(replay.pty?.launchToken).toBe('controlled-launch')
          expect(replay.channelOrder).not.toContain('fact:agent-exited')
        } finally {
          replay.dispose()
        }
      }
    }
  )
})
