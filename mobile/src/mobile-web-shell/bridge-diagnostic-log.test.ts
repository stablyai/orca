import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { createBridgeDiagnosticReporter } from './bridge-diagnostic-log'

let warned: MockInstance<typeof console.warn>

beforeEach(() => {
  warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  warned.mockClear()
})

function readPart(part: unknown): string {
  return part instanceof Error ? part.message : JSON.stringify(part)
}

/** What a reader has to be able to tell apart from the line alone. */
function lines(): string[] {
  return warned.mock.calls.map((call) => call.map(readPart).join(' '))
}

describe('the bridge diagnostic log', () => {
  it('names the notification it refused and why, for each refusal', () => {
    const report = createBridgeDiagnosticReporter()
    report({ kind: 'notify-refused', name: 'fault', why: 'before-ready' })
    report({ kind: 'notify-refused', name: 'fault', why: 'ungranted' })
    expect(lines()).toHaveLength(2)
    expect(lines()[0]).toContain('fault')
    expect(lines()[0]).toContain('before-ready')
    expect(lines()[1]).toContain('ungranted')
  })

  it('still holds one page to a line per refusal, however many frames it posts', () => {
    const report = createBridgeDiagnosticReporter()
    report({ kind: 'notify-refused', name: 'fault', why: 'before-ready' })
    report({ kind: 'notify-refused', name: 'fault', why: 'before-ready' })
    expect(warned).toHaveBeenCalledTimes(1)
  })

  it('says a view outlived its host only for a frame that did', () => {
    const report = createBridgeDiagnosticReporter()
    report({ kind: 'frame-after-dispose' })
    report({ kind: 'notify-refused', name: 'fault', why: 'before-ready' })
    report({ kind: 'route-refused', issue: 'the shell named no screen' })
    expect(lines()[0]).toContain('outlived')
    expect(lines()[1]).not.toContain('outlived')
    expect(lines()[2]).not.toContain('outlived')
  })

  it('names the key a page was refused a write to', () => {
    const report = createBridgeDiagnosticReporter()
    report({ kind: 'storage-refused', key: 'orca:pins:another-host' })
    expect(lines()[0]).toContain('orca:pins:another-host')
    expect(lines()[0]).not.toContain('outlived')
  })

  it('carries what was wrong with the screen the shell named', () => {
    const report = createBridgeDiagnosticReporter()
    report({ kind: 'route-refused', issue: 'the shell named no screen' })
    expect(lines()[0]).toContain('the shell named no screen')
  })

  it('carries the cause of the kinds that have one', () => {
    const report = createBridgeDiagnosticReporter()
    report({ kind: 'refused', refusal: 'malformed-json' })
    report({ kind: 'post-failed', error: new Error('no view') })
    report({ kind: 'notify-failed', error: new Error('the listener threw') })
    expect(lines()[0]).toContain('malformed-json')
    expect(lines()[1]).toContain('no view')
    expect(lines()[2]).toContain('the listener threw')
  })

  /**
   * The backlog report, which is the only oracle the coalescing rule has.
   *
   * Nothing crosses to the page saying how much was held, and both ways a held stream dies reach it
   * as `overflow`, because a reason its reader has never heard of is a frame it drops. So the four
   * numbers and `ended` are the whole evidence, and without a branch of its own the report fell
   * through to the "a view outlived its host" warn with every field discarded.
   */
  it('reports what a held terminal stream did, rather than calling it an outlived view', () => {
    const report = createBridgeDiagnosticReporter()
    report({
      kind: 'terminal-backlog',
      id: 'stream-1',
      coalescedFrames: 9,
      deliveredFrames: 4,
      peakPendingBytes: 131_072,
      ended: 'ack-silence'
    })
    expect(lines()[0]).not.toContain('outlived')
    for (const part of ['stream-1', '9', '4', '131072', 'ack-silence']) {
      expect(lines()[0]).toContain(part)
    }
  })

  it('keeps one line per stream, so a second terminal is not buried by the first', () => {
    // Keyed by kind alone, one backlog per host was reported and every other stream was silent —
    // which is the case the report exists for, since a shell holds a stream per open terminal.
    const report = createBridgeDiagnosticReporter()
    report({
      kind: 'terminal-backlog',
      id: 'stream-1',
      coalescedFrames: 1,
      deliveredFrames: 1,
      peakPendingBytes: 10,
      ended: null
    })
    report({
      kind: 'terminal-backlog',
      id: 'stream-2',
      coalescedFrames: 2,
      deliveredFrames: 2,
      peakPendingBytes: 20,
      ended: 'pending-ceiling'
    })
    report({
      kind: 'terminal-backlog',
      id: 'stream-1',
      coalescedFrames: 3,
      deliveredFrames: 3,
      peakPendingBytes: 30,
      ended: null
    })
    expect(lines()).toHaveLength(2)
    expect(lines()[1]).toContain('stream-2')
  })
})
