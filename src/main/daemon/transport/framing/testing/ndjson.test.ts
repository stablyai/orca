import { describe, expect, it, vi } from 'vitest'
import {
  encodeNdjson,
  createNdjsonParser,
  NdjsonLineTooLongError,
  createIncrementalNdjsonFramer
} from '../../../../../shared/main-process-ndjson-framer'

describe('encodeNdjson', () => {
  it('measures multibyte payloads in UTF-8 bytes, not characters', () => {
    const emptyBytes = Buffer.byteLength(JSON.stringify({ data: '' }), 'utf8')
    expect(encodeNdjson({ data: '🐙' }, emptyBytes + 4)).toBe('{"data":"🐙"}\n')
    expect(() => encodeNdjson({ data: '🐙' }, emptyBytes + 3)).toThrow(NdjsonLineTooLongError)
    expect(() => encodeNdjson({ data: 'é' }, emptyBytes + 1)).toThrow(NdjsonLineTooLongError)
  })
})

describe('createNdjsonParser', () => {
  it('recovers after malformed JSON and parses next line', () => {
    const onMessage = vi.fn()
    const onError = vi.fn()
    const parser = createNdjsonParser(onMessage, onError)

    parser.feed('bad\n{"good":true}\n')

    expect(onError).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith({ good: true })
  })

  it('drops oversized complete lines and parses following messages', () => {
    const onMessage = vi.fn()
    const onError = vi.fn()
    const parser = createNdjsonParser(onMessage, onError, { maxLineBytes: 24 })

    parser.feed(`${'x'.repeat(25)}\n{"good":true}\n`)

    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).toContain('NDJSON line exceeds max 24 bytes')
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith({ good: true })
  })

  it('discards oversized partial lines until the next delimiter', () => {
    const onMessage = vi.fn()
    const onError = vi.fn()
    const parser = createNdjsonParser(onMessage, onError, { maxLineBytes: 24 })

    parser.feed('{"too":')
    parser.feed(`"${'x'.repeat(24)}"}`)
    parser.feed('\n{"fresh":true}\n')

    expect(onError).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledOnce()
    expect(onMessage).toHaveBeenCalledWith({ fresh: true })
  })

  it('retains a valid suffix when paused input overflows after an oversized partial line', () => {
    const records: unknown[] = []
    const rejected: unknown[] = []
    let paused = true
    const framer = createIncrementalNdjsonFramer(
      (record) => records.push(record),
      (error) => rejected.push(error),
      { maxLineBytes: 32, shouldPause: () => paused }
    )

    // Leave an unfinished paused record to verify the size cap on later input.
    framer.feed('{}\nx')
    framer.feed(`${'y'.repeat(70_000)}\n{"good":true}\n`)

    paused = false
    framer.resume()

    expect(rejected).toHaveLength(1)
    expect(records).toEqual([{}, { good: true }])
  })

  it('does not drop data fed after queued records when the consumer resumes', () => {
    const records: unknown[] = []
    let paused = true
    const framer = createIncrementalNdjsonFramer(
      (record) => records.push(record),
      (error) => {
        throw error
      },
      { shouldPause: () => paused }
    )

    framer.feed('{"queued":true}\n')
    paused = false
    framer.feed('{"after":true}\n')

    expect(records).toEqual([{ queued: true }, { after: true }])
  })

  it('does not dispatch a pending suffix ahead of queued records after re-pause', () => {
    const records: unknown[] = []
    let paused = true
    const framer = createIncrementalNdjsonFramer(
      (record) => {
        records.push(record)
        if ((record as { index?: number }).index === 1) {
          paused = true
        }
      },
      (error) => {
        throw new Error(`unexpected rejection: ${JSON.stringify(error)}`)
      },
      { shouldPause: () => paused }
    )

    framer.feed('{"index":0}\n{"index":1}\n{"index":2}\n{"index":')
    paused = false
    framer.resume()

    expect(records).toEqual([{ index: 0 }, { index: 1 }])
    paused = false
    framer.resume()
    expect(records).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }])

    framer.feed('3}\n')
    expect(records).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }])
  })

  it('discards only the paused oversized tail after delivering older records across re-pauses', () => {
    const records: unknown[] = []
    const rejected: unknown[] = []
    let paused = false
    const framer = createIncrementalNdjsonFramer(
      (record) => {
        records.push(record)
        if (records.length <= 2) {
          paused = true
        }
      },
      (error) => rejected.push(error),
      { maxLineBytes: 32, shouldPause: () => paused }
    )
    framer.feed('{"a":1}\n{"b":2}\n{"c":3}\n{"oversized":"')
    framer.feed('x'.repeat(64 * 1024))
    expect(rejected).toEqual([
      expect.objectContaining({
        prefix: expect.stringMatching(/^\{"oversized":/),
        maxLineBytes: 64 * 1024
      })
    ])
    expect(framer.takeTail()).toBe('')
    paused = false
    framer.resume()
    expect(records).toEqual([{ a: 1 }, { b: 2 }])
    paused = false
    framer.feed('still discarded')
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }])
    paused = true
    framer.feed('"}\n{"d":4}\n{"e":')
    expect(records).toHaveLength(3)
    paused = false
    framer.resume()
    framer.feed('5}\n')
    expect(records).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }])
    expect(rejected).toHaveLength(1)
  })

  it('caps an actually incomplete paused suffix and recovers at the next delimiter', () => {
    const records: unknown[] = []
    const rejected: unknown[] = []
    let paused = true
    const framer = createIncrementalNdjsonFramer(
      (record) => records.push(record),
      (error) => rejected.push(error),
      { maxLineBytes: 32, shouldPause: () => paused }
    )

    framer.feed('{}\nx')
    framer.feed('y'.repeat(70_000))
    expect(framer.takeTail()).toBe('')
    framer.feed('more discarded bytes')
    paused = false
    framer.resume()
    framer.feed('\n{"recovered":true}\n')

    expect(rejected).toHaveLength(1)
    expect(records).toEqual([{}, { recovered: true }])
  })
})
