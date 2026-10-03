import { describe, expect, it, vi } from 'vitest'
import { appendDaemonStreamData, flushDaemonStreamSession } from './daemon-stream-data-entry'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import { SessionOutputPlane } from './session-output-plane'

function batch(): PendingStreamDataBatch {
  return {
    timer: null,
    queue: [],
    queuedChars: 0,
    queuedCharsBySession: new Map(),
    queuedMetadataBytesBySession: new Map(),
    droppableQueuedSessionIds: new Set()
  }
}

describe('daemon stream incarnation ids', () => {
  it('never merges output from two incarnations into one queued entry', () => {
    const pending = batch()
    appendDaemonStreamData(pending, 'session-1', 'old', { incarnationId: 'incarnation-1' })
    appendDaemonStreamData(pending, 'session-1', 'more', { incarnationId: 'incarnation-1' })
    appendDaemonStreamData(pending, 'session-1', 'new', { incarnationId: 'incarnation-2' })

    expect(pending.queue.map(({ data, incarnationId }) => ({ data, incarnationId }))).toEqual([
      { data: 'oldmore', incarnationId: 'incarnation-1' },
      { data: 'new', incarnationId: 'incarnation-2' }
    ])
  })

  it('writes the id on per-session flushes and omits it when absent', () => {
    const pending = batch()
    appendDaemonStreamData(pending, 'session-1', 'tagged', { incarnationId: 'incarnation-1' })
    appendDaemonStreamData(pending, 'session-1', 'legacy', {})
    const lines: string[] = []
    flushDaemonStreamSession(pending, 'session-1', 64 * 1024, (line) => lines.push(line))

    const payloads = lines.map((line) => JSON.parse(line).payload)
    expect(payloads).toEqual([
      { data: 'tagged', incarnationId: 'incarnation-1' },
      { data: 'legacy' }
    ])
  })

  it('hands the session incarnation only to identity-aware clients', () => {
    const plane = new SessionOutputPlane({ cols: 80, rows: 24, incarnationId: 'incarnation-1' })
    const legacy = vi.fn()
    const aware = vi.fn()
    const unused = vi.fn()
    plane.attachClient({ onData: legacy, onExit: vi.fn() })
    plane.attachClient({ onData: unused, onDataWithIncarnation: aware, onExit: vi.fn() })

    plane.emit({ data: 'hi', rawStartSeq: 0, rawEndSeq: 2, transformed: false })

    expect(legacy).toHaveBeenCalledWith('hi')
    expect(aware).toHaveBeenCalledWith('hi', undefined, undefined, undefined, 'incarnation-1')
    expect(unused).not.toHaveBeenCalled()
    plane.disposeEmulator()
  })
})
