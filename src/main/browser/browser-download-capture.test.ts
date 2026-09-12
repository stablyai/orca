import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserDownloadCapture, BROWSER_DOWNLOAD_TIMEOUT_MS } from './browser-download-capture'

let root: string
let captures: BrowserDownloadCapture
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-download-capture-'))
  captures = new BrowserDownloadCapture()
})
afterEach(() => {
  captures.cancelAll()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('native download capture', () => {
  it('returns the exact native path and byte count only after completion', async () => {
    const path = join(root, 'requested.txt')
    const pending = captures.begin('page', path)
    captures.failNavigation('page', Object.assign(new Error('ERR_FAILED (-2)'), { errno: -2 }))
    const capture = captures.claim('page', vi.fn())!
    expect(capture.destination.savePath).toBe(path)
    expect(captures.claim('page', vi.fn())).toBeUndefined()
    captures.failNavigation('page', Object.assign(new Error('ERR_ABORTED (-3)'), { errno: -3 }))
    writeFileSync(capture.destination.savePath, 'native bytes\n')
    capture.finish({ downloadId: 'download', status: 'completed', savePath: path, error: null })
    await expect(pending.result).resolves.toEqual({
      path,
      filename: 'requested.txt',
      downloadId: 'download',
      bytes: 13
    })
    expect(readFileSync(path, 'utf8')).toBe('native bytes\n')
  })

  it('correlates an explicitly routed child but never another page', async () => {
    const path = join(root, 'blank.txt')
    const pending = captures.begin('opener', path)
    captures.inherit('opener', 'child', 'https://example.com/attachment')
    expect(captures.takeNavigation('child')).toBe('https://example.com/attachment')
    expect(captures.takeNavigation('child')).toBeUndefined()
    expect(captures.claim('unrelated', vi.fn())).toBeUndefined()
    const capture = captures.claim('child', vi.fn())!
    writeFileSync(path, 'attachment')
    capture.finish({
      downloadId: 'child-download',
      status: 'completed',
      savePath: path,
      error: null
    })
    await expect(pending.result).resolves.toMatchObject({ path, bytes: 10 })
    expect(captures.claim('opener', vi.fn())).toBeUndefined()
  })

  it('refuses an existing or reserved requested path without overwriting bytes', () => {
    const path = join(root, 'collision.txt')
    captures.begin('first', path)
    expect(() => captures.begin('second', path)).toThrow(/already exists or is in use/)
    captures.cancelAll()
    writeFileSync(path, 'keep')
    expect(() => captures.begin('third', path)).toThrow(/already exists or is in use/)
    expect(readFileSync(path, 'utf8')).toBe('keep')
  })

  it('reports inert clicks as a download timeout and permits a later capture', async () => {
    vi.useFakeTimers()
    const path = join(root, 'inert.txt')
    const pending = captures.begin('page', path)
    captures.failNavigation('page', Object.assign(new Error('ERR_FAILED (-2)'), { errno: -2 }))
    const failed = expect(pending.result).rejects.toMatchObject({
      code: 'browser_download_timeout',
      message: 'No download started within 60 seconds.'
    })
    await vi.advanceTimersByTimeAsync(BROWSER_DOWNLOAD_TIMEOUT_MS)
    await failed
    expect(() => captures.begin('page', path)).not.toThrow()
  })

  it('reports a navigation failure and retires the child navigation', async () => {
    const pending = captures.begin('page', join(root, 'navigation.txt'))
    captures.inherit('page', 'child', 'https://example.com/attachment')
    captures.failNavigation('child', new Error('network failed'))
    await expect(pending.result).rejects.toMatchObject({ code: 'browser_download_failed' })
    expect(captures.takeNavigation('child')).toBeUndefined()
  })

  it('cancels a stalled DownloadItem at the deadline', async () => {
    vi.useFakeTimers()
    const pending = captures.begin('page', join(root, 'stalled.txt'))
    const cancelItem = vi.fn()
    captures.claim('page', cancelItem)
    const failed = expect(pending.result).rejects.toMatchObject({
      code: 'browser_download_timeout'
    })
    await vi.advanceTimersByTimeAsync(BROWSER_DOWNLOAD_TIMEOUT_MS)
    await failed
    expect(cancelItem).toHaveBeenCalledOnce()
  })

  it.each(['canceled', 'failed'] as const)('preserves the native %s outcome', async (status) => {
    const pending = captures.begin('page', join(root, 'failed.txt'))
    captures
      .claim('page', vi.fn())!
      .finish({ downloadId: 'download', status, savePath: null, error: 'Native failure.' })
    await expect(pending.result).rejects.toMatchObject({
      code: status === 'canceled' ? 'browser_download_canceled' : 'browser_download_failed'
    })
  })
})
