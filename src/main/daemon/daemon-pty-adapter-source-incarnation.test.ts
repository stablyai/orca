import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { PtyDataEvent, PtyBackgroundStreamEvent } from '../providers/types'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'

describe('DaemonPtyAdapter source incarnation', () => {
  let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>>
  let subprocess: ReturnType<typeof createMockSubprocess>
  beforeEach(async () => {
    harness = await startDaemonAdapterHarness(() => {
      subprocess = createMockSubprocess()
      return subprocess
    })
  })
  afterEach(async () => {
    harness.adapter.dispose()
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('delivers successor bytes before its control reply without changing the admitted binding, and preserves same-incarnation attach', async () => {
    const { adapter } = harness
    const id = 'early-source'
    adapter['sessionIncarnations'].set(id, 'cached-predecessor')
    const data: PtyDataEvent[] = []
    adapter.onData((event) => data.push(event))
    const originalRequest = adapter['client'].request.bind(adapter['client'])
    let source: string | undefined
    vi.spyOn(adapter['client'], 'request').mockImplementation(async (type, payload) => {
      const reply = await originalRequest(type, payload)
      if (type === 'createOrAttach') {
        source = (reply as { incarnationId: string }).incarnationId
        subprocess._simulateData('\x1b]0;same title\x07')
        await waitFor(() => data.length > 0)
        expect(data[0]).toEqual({ id, data: '\x1b]0;same title\x07', incarnationId: source })
        expect(adapter['sessionIncarnations'].get(id)).toBe('cached-predecessor')
      }
      return reply
    })
    const result = await adapter.spawn({ sessionId: id, cols: 80, rows: 24 })
    expect(result.incarnationId).toBe(source)
    vi.restoreAllMocks()
    data.length = 0
    const attached = await adapter.spawn({ sessionId: id, cols: 80, rows: 24 })
    subprocess._simulateData('same owner')
    await waitFor(() => data.length > 0)
    expect(attached.incarnationId).toBe(source)
    expect(data).toEqual([{ id, data: 'same owner', incarnationId: source }])
  })

  it('delivers delayed predecessor facts, gaps and queries with their own source, never a later control binding', () => {
    let emit: (event: unknown) => void = () => {
      throw new Error('listener not installed')
    }
    vi.spyOn(DaemonClient.prototype, 'onEvent').mockImplementation((listener) => {
      emit = listener
      return () => {}
    })
    const adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    const data: PtyDataEvent[] = []
    const facts: PtyBackgroundStreamEvent[] = []
    adapter.onData((event) => data.push(event))
    adapter.onBackgroundStreamEvent((event) => facts.push(event))
    adapter['setupEventRouting']()
    adapter['sessionIncarnations'].set('s', 'finally-admitted')
    try {
      for (const incarnationId of ['old', 'intermediate', undefined]) {
        const source = incarnationId === undefined ? {} : { incarnationId }
        emit({
          type: 'event',
          event: 'data',
          sessionId: 's',
          payload: { data: '\x1b[6n', sequenceChars: 0, ...source }
        })
        emit({
          type: 'event',
          event: 'dataGap',
          sessionId: 's',
          payload: { droppedChars: 512, sequenceChars: 508, ...source }
        })
        emit({
          type: 'event',
          event: 'transientFact',
          sessionId: 's',
          payload: { kind: 'command-finished', exitCode: 0, ...source }
        })
        emit({
          type: 'event',
          event: 'sessionBackgroundMarker',
          sessionId: 's',
          payload: { background: false, scanSeedAnsi: '\x1b]133;', ...source }
        })
        expect(data.at(-1)).toEqual({ id: 's', data: '\x1b[6n', sequenceChars: 0, ...source })
        expect(facts.slice(-3)).toEqual([
          { id: 's', kind: 'dataGap', droppedChars: 512, sequenceChars: 508, ...source },
          {
            id: 's',
            kind: 'transientFact',
            fact: { kind: 'command-finished', exitCode: 0 },
            ...source
          },
          {
            id: 's',
            kind: 'backgroundMarker',
            background: false,
            scanSeedAnsi: '\x1b]133;',
            ...source
          }
        ])
      }
      expect(adapter['sessionIncarnations'].get('s')).toBe('finally-admitted')
      expect(data).toHaveLength(3)
      expect(facts).toHaveLength(9)
    } finally {
      adapter.dispose()
    }
  })

  it('attributes daemon-derived facts and scan seeds to the actual Session', async () => {
    const { adapter } = harness
    const result = await adapter.spawn({ sessionId: 'background-source', cols: 80, rows: 24 })
    const facts: PtyBackgroundStreamEvent[] = []
    adapter.onBackgroundStreamEvent((event) => facts.push(event))
    await adapter['client'].request('setSessionBackground', {
      sessionId: result.id,
      background: true
    })
    subprocess._simulateData('\x1b]133;D;0\x07')
    await waitFor(() => facts.some((event) => event.kind === 'transientFact'))
    expect(facts).toContainEqual({
      id: result.id,
      kind: 'backgroundMarker',
      background: true,
      incarnationId: result.incarnationId
    })
    expect(facts).toContainEqual({
      id: result.id,
      kind: 'transientFact',
      fact: { kind: 'command-finished', exitCode: 0 },
      incarnationId: result.incarnationId
    })
  })
})
