import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import {
  assertClipboardTextWriteWithinLimitWithYield,
  CLIPBOARD_TEXT_WRITE_MAX_BYTES
} from '../../../shared/clipboard-text'
import { CLIPBOARD_IMAGE_MAX_BASE64_CHARS } from '../../../shared/clipboard-image'
import { createClipboardPublisher } from './clipboard-text-publisher'

vi.mock('electron', () => ({ app: {}, clipboard: {} }))

const ok: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
const run = vi.fn(async (_spec: ProcessSpec): Promise<ProcessResult> => ok)
const write = vi.fn()
const clearCache = vi.fn()
function publisher(wayland = true, validate = assertClipboardTextWriteWithinLimitWithYield) {
  return createClipboardPublisher({
    isWayland: () => wayland,
    helperPath: () => '/bundle/bin/orca-wayland-clipboard',
    run,
    write,
    clearCache,
    validate
  })
}
function writer(wayland = true, validate = assertClipboardTextWriteWithinLimitWithYield) {
  return publisher(wayland, validate).publishText
}

describe('terminal clipboard writes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    run.mockResolvedValue(ok)
  })

  it.each([
    ['timeout', { ...ok, code: null, timedOut: true }],
    ['helper failure', { ...ok, code: 70 }]
  ])('rejects %s without falling back to an unsafe Electron write', async (_label, result) => {
    run.mockResolvedValueOnce(result)
    await expect(writer()('copy')).rejects.toThrow('Wayland clipboard write failed')
    expect(write).not.toHaveBeenCalled()
    expect(clearCache).not.toHaveBeenCalled()
  })

  it('rejects oversized text before either clipboard backend is invoked', async () => {
    await expect(writer()('x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES + 1))).rejects.toThrow(
      'Clipboard text is too large'
    )
    expect(run).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'count', count: 32, bytes: 1 },
    { label: 'retained bytes', count: 1, bytes: CLIPBOARD_IMAGE_MAX_BASE64_CHARS * 2 }
  ])(
    'bounds other clipboard operations by $label and releases capacity after failure',
    async ({ count, bytes }) => {
      const copy = publisher(false)
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const publications: number[] = []
      const first = copy.publish(bytes, async () => {
        await gate
        throw new Error('file helper failed')
      })
      const rejected = expect(first).rejects.toThrow('file helper failed')
      const queued = Array.from({ length: count - 1 }, (_, index) =>
        copy.publish(bytes, () => {
          publications.push(index)
          return index
        })
      )
      await expect(copy.publish(bytes, () => publications.push(-1))).rejects.toThrow(
        'Too many pending clipboard writes'
      )
      expect(publications).toEqual([])
      const text = copy.publishText('after failed file', 'ordinary')
      release()
      await rejected
      await Promise.all(queued)
      await text
      expect(publications).toHaveLength(count - 1)
      expect(publications).not.toContain(-1)
      expect(write).toHaveBeenLastCalledWith('after failed file', 'ordinary')
      await expect(copy.publish(bytes, () => 'after flood')).resolves.toBe('after flood')
    }
  )

  it('bounds requests queued behind a stalled helper', async () => {
    let release: (value: typeof ok) => void = () => undefined
    run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const copy = writer()
    const queued = Array.from({ length: 32 }, (_, index) => copy(String(index)))
    await expect(copy('overflow')).rejects.toThrow('Too many pending clipboard writes')
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    release(ok)
    await Promise.all(queued)
    await copy('after flood')
    expect(run).toHaveBeenCalledTimes(33)
  })

  it('bounds the total text retained behind a stalled helper', async () => {
    let release: (value: typeof ok) => void = () => undefined
    run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const copy = writer(true, async (text) => text)
    const text = 'x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES / 2 + 1)
    const first = copy(text)
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    let failure: unknown
    void copy(text).catch((error: unknown) => {
      failure = error
    })
    await vi.waitFor(
      () => expect(failure).toEqual(new Error('Too many pending clipboard writes')),
      { timeout: 200 }
    )
    release(ok)
    await first
    await copy(text)
    expect(run).toHaveBeenCalledTimes(2)
  })
})
