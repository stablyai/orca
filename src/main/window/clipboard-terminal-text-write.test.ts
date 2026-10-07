import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../shared/child-process/run-process'
import {
  assertClipboardTextWriteWithinLimitWithYield,
  CLIPBOARD_TEXT_WRITE_MAX_BYTES
} from '../../shared/clipboard-text'
import { createTerminalClipboardWriter } from './clipboard-terminal-text-write'

vi.mock('electron', () => ({ app: {}, clipboard: {} }))

const ok: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
const run = vi.fn(async (_spec: ProcessSpec): Promise<ProcessResult> => ok)
const write = vi.fn()
const clearCache = vi.fn()
function writer(wayland = true, validate = assertClipboardTextWriteWithinLimitWithYield) {
  return createTerminalClipboardWriter({
    isWayland: () => wayland,
    helperPath: () => '/bundle/bin/orca-wayland-clipboard',
    run,
    write,
    clearCache,
    validate
  })
}

describe('terminal clipboard writes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    run.mockResolvedValue(ok)
  })

  it('publishes different and duplicate text without asking Electron to own the selection', async () => {
    const copy = writer()
    const text = '遥か\r\nline two\n'
    await copy(text)
    await copy(text)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledWith({
      program: '/bundle/bin/orca-wayland-clipboard',
      input: text,
      timeoutMs: 2000,
      stdio: ['pipe', 'ignore', 'ignore']
    })
    expect(write).not.toHaveBeenCalled()
    expect(clearCache).toHaveBeenCalledTimes(2)
  })

  it('only discards a rejected Chromium source after the new owner is acknowledged', async () => {
    let release: (value: typeof ok) => void = () => undefined
    run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const pending = writer()('copy')
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    expect(clearCache).not.toHaveBeenCalled()
    release(ok)
    await pending
    expect(clearCache).toHaveBeenCalledTimes(1)
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

  it('preserves the existing clipboard when the bundled helper cannot start', async () => {
    run.mockRejectedValueOnce(new Error('ENOENT'))
    await expect(writer()('copy')).rejects.toThrow('ENOENT')
    expect(write).not.toHaveBeenCalled()
    expect(clearCache).not.toHaveBeenCalled()
  })

  it('retains verified Electron writes outside native Wayland', async () => {
    await writer(false)('copy')
    expect(write).toHaveBeenCalledWith('copy')
    expect(run).not.toHaveBeenCalled()
    expect(clearCache).not.toHaveBeenCalled()
  })

  it('keeps the existing backend when the compositor exposes neither data-control protocol', async () => {
    run.mockResolvedValueOnce({ ...ok, code: 78 })
    const copy = writer()
    await copy('first')
    await copy('second')
    expect(run).toHaveBeenCalledTimes(1)
    expect(write.mock.calls).toEqual([['first'], ['second']])
    expect(clearCache).not.toHaveBeenCalled()
  })

  it('does not downgrade after a desktop has already accepted a data-control copy', async () => {
    run.mockResolvedValueOnce(ok).mockResolvedValueOnce({ ...ok, code: 78 })
    const copy = writer()
    await copy('first')
    await expect(copy('second')).rejects.toThrow('Wayland clipboard write failed')
    expect(write).not.toHaveBeenCalled()
    expect(clearCache).toHaveBeenCalledTimes(1)
    await copy('third')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('rejects oversized text before either clipboard backend is invoked', async () => {
    await expect(writer()('x'.repeat(CLIPBOARD_TEXT_WRITE_MAX_BYTES + 1))).rejects.toThrow(
      'Clipboard text is too large'
    )
    expect(run).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it.each([null, 42, { length: 0 }])(
    'rejects invalid payload %j before validation or queueing',
    async (text) => {
      const validate = vi.fn(async (value: string) => value)
      await expect(writer(true, validate)(text)).rejects.toThrow('Clipboard text must be a string')
      expect(validate).not.toHaveBeenCalled()
      expect(run).not.toHaveBeenCalled()
    }
  )

  it('preserves request order across yielding validation and resumes after failure', async () => {
    let release: (text: string) => void = () => undefined
    const validate = vi.fn(async (text: string) => text)
    validate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    run.mockRejectedValueOnce(new Error('helper failed'))
    const copy = writer(true, validate)
    const first = copy('first')
    const firstRejected = expect(first).rejects.toThrow('helper failed')
    const second = copy('second')
    await vi.waitFor(() => expect(validate).toHaveBeenCalledTimes(1))
    expect(run).not.toHaveBeenCalled()
    release('first')
    await firstRejected
    await second
    expect(run.mock.calls.map(([spec]) => spec.input)).toEqual(['first', 'second'])
    expect(clearCache).toHaveBeenCalledTimes(1)
  })

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
