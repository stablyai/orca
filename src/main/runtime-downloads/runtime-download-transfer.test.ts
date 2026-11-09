import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RuntimeDownloadError,
  transferRuntimeFile,
  transferRuntimeFolder,
  type RuntimeDownloadCall
} from './runtime-download-transfer'

let dir: string

/** A scripted host; the transfer code names each method's result type itself. */
function fakeCall<P>(impl: (method: string, params: P) => Promise<unknown>): RuntimeDownloadCall {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each scripted reply matches the result type the transfer code expects for that method.
  return impl as RuntimeDownloadCall
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-runtime-download-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function fileHost(content: Buffer, statSize = content.byteLength): RuntimeDownloadCall {
  return fakeCall(async (method: string, params: { offset: number; length: number }) => {
    if (method === 'files.stat') {
      return { size: statSize, isDirectory: false }
    }
    const bytes = content.subarray(params.offset, params.offset + params.length)
    // Out-of-order replies: later pages may land first.
    for (let turn = 0; turn < (params.offset / 7) % 3; turn += 1) {
      await Promise.resolve()
    }
    return {
      contentBase64: bytes.toString('base64'),
      bytesRead: bytes.byteLength,
      eof: params.offset + bytes.byteLength >= content.byteLength
    }
  })
}

async function runFile(call: RuntimeDownloadCall, extra: { maxBytes?: number } = {}) {
  const sink = await open(join(dir, 'out'), 'w+')
  try {
    const result = await transferRuntimeFile({
      call,
      worktree: 'wt',
      relativePath: 'a.bin',
      sink,
      signal: new AbortController().signal,
      onProgress: () => {},
      chunkBytes: 7,
      concurrency: 3,
      ...extra
    })
    return { result, bytes: await readFile(join(dir, 'out')) }
  } finally {
    await sink.close()
  }
}

describe('transferRuntimeFile', () => {
  it('reassembles pages fetched in parallel in order', async () => {
    const content = Buffer.from('the quick brown fox jumps over the lazy dog, twice over')
    const { result, bytes } = await runFile(fileHost(content))
    expect(result.bytes).toBe(content.byteLength)
    expect(bytes.equals(content)).toBe(true)
  })

  it('keeps a file that shrank after stat to its final length', async () => {
    const content = Buffer.from('short file')
    const { bytes } = await runFile(fileHost(content, 1000))
    expect(bytes.toString()).toBe('short file')
  })

  it('downloads an empty file', async () => {
    const { bytes } = await runFile(fileHost(Buffer.alloc(0)))
    expect(bytes.byteLength).toBe(0)
  })

  it('refuses a file over the caller limit before reading it', async () => {
    await expect(runFile(fileHost(Buffer.alloc(20)), { maxBytes: 10 })).rejects.toEqual(
      new RuntimeDownloadError('too_large')
    )
  })
})

describe('transferRuntimeFolder', () => {
  it('releases the host archive when the download is canceled', async () => {
    const controller = new AbortController()
    const calls: string[] = []
    const call = fakeCall(async (method: string) => {
      calls.push(method)
      if (method === 'files.archiveStart') {
        return { archiveId: 'z1', totalBytes: 10, excludedDirCount: 0, fileCount: 1 }
      }
      if (method === 'files.archiveRead') {
        controller.abort()
        return {
          contentBase64: 'AA==',
          bytesRead: 1,
          eof: false,
          processedBytes: 1,
          skippedCount: 0
        }
      }
      return { released: true }
    })
    const sink = await open(join(dir, 'out.zip'), 'w+')
    try {
      await expect(
        transferRuntimeFolder({
          call,
          worktree: 'wt',
          relativePath: 'src',
          sink,
          signal: controller.signal,
          onProgress: () => {},
          excludeDefaultDirs: true
        })
      ).rejects.toEqual(new RuntimeDownloadError('canceled'))
    } finally {
      await sink.close()
    }
    expect(calls).toEqual(['files.archiveStart', 'files.archiveRead', 'files.archiveCancel'])
  })

  it('releases an archive whose start reply lands after the user canceled', async () => {
    const controller = new AbortController()
    const calls: { method: string; params: unknown }[] = []
    let finishStart: (value: unknown) => void = () => {}
    const call = fakeCall(async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'files.archiveStart') {
        return new Promise<unknown>((resolve) => {
          finishStart = resolve
        })
      }
      return { released: true }
    })
    const sink = await open(join(dir, 'late.zip'), 'w+')
    try {
      const transfer = transferRuntimeFolder({
        call,
        worktree: 'wt',
        relativePath: 'src',
        sink,
        signal: controller.signal,
        onProgress: () => {},
        excludeDefaultDirs: true
      })
      controller.abort()
      // Canceled at once, before the host has even finished walking.
      await expect(transfer).rejects.toEqual(new RuntimeDownloadError('canceled'))
      finishStart({ archiveId: 'late', totalBytes: 1, excludedDirCount: 0, fileCount: 1 })
      await vi.waitFor(() => expect(calls).toHaveLength(2))
    } finally {
      await sink.close()
    }
    expect(calls.map((entry) => entry.method)).toEqual([
      'files.archiveStart',
      'files.archiveCancel'
    ])
    expect(calls[1].params).toEqual({ archiveId: 'late' })
  })
})
