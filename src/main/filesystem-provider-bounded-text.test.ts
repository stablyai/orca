import { describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from './providers/types'
import { readFilesystemProviderBoundedText } from './filesystem-provider-bounded-text'

const limits = { maxBytes: 8, maxCodeUnits: 8 }

function provider(args: {
  size: number
  content?: string
  isBinary?: boolean
}): IFilesystemProvider {
  return {
    stat: vi.fn().mockResolvedValue({
      size: args.size,
      type: 'file',
      mtime: 0
    }),
    readFile: vi.fn().mockResolvedValue({
      content: args.content ?? '',
      isBinary: args.isBinary ?? false
    })
  } as unknown as IFilesystemProvider
}

describe('readFilesystemProviderBoundedText', () => {
  it('reads a file at the exact byte boundary', async () => {
    const fsProvider = provider({ size: limits.maxBytes, content: '12345678' })

    await expect(
      readFilesystemProviderBoundedText(fsProvider, '/repo/orca.yaml', limits)
    ).resolves.toEqual({ kind: 'text', content: '12345678' })
    expect(fsProvider.readFile).toHaveBeenCalledOnce()
  })

  it('rejects a +1 stat before remote materialization', async () => {
    const fsProvider = provider({ size: limits.maxBytes + 1, content: 'not read' })

    await expect(
      readFilesystemProviderBoundedText(fsProvider, '/repo/orca.yaml', limits)
    ).resolves.toEqual({ kind: 'oversized' })
    expect(fsProvider.readFile).not.toHaveBeenCalled()
  })

  it('rechecks UTF-8 bytes after a stat/read race', async () => {
    const fsProvider = provider({ size: 2, content: '🐋🐋🐋' })

    await expect(
      readFilesystemProviderBoundedText(fsProvider, '/repo/orca.yaml', limits)
    ).resolves.toEqual({ kind: 'oversized' })
  })

  it('rechecks code units after a stat/read race', async () => {
    const fsProvider = provider({ size: 2, content: '123456789' })

    await expect(
      readFilesystemProviderBoundedText(fsProvider, '/repo/orca.yaml', limits)
    ).resolves.toEqual({ kind: 'oversized' })
  })

  it('preserves binary classification', async () => {
    const fsProvider = provider({ size: 2, content: 'xx', isBinary: true })

    await expect(
      readFilesystemProviderBoundedText(fsProvider, '/repo/orca.yaml', limits)
    ).resolves.toEqual({ kind: 'binary' })
  })
})
