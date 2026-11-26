// Guards STA-18472 (PR #49343): a WSL tab folder only needs to know whether a link exists, so its probe stops at the first one.
import { basename, join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const lstatCalls: string[] = []
vi.mock('node:fs/promises', () => ({
  lstat: async (path: string) => {
    lstatCalls.push(path)
    return { isSymbolicLink: () => basename(path) === 'linked' }
  }
}))

const { findSymlinkBelowRoot } = await import('./filesystem-symlink-ancestor')

const root = resolve('ws')

async function lstatsFor(depth: number, which: 'first' | 'deepest'): Promise<number> {
  lstatCalls.length = 0
  const below = Array.from({ length: depth - 1 }, (_, i) => `d${i}`)
  const found = await findSymlinkBelowRoot(root, join(root, 'linked', ...below), which)
  expect(found).toBe(join(root, 'linked'))
  return lstatCalls.length
}

describe('findSymlinkBelowRoot', () => {
  it('stops at the first link when only its existence matters', async () => {
    expect(await lstatsFor(10, 'first')).toBe(1)
    expect(await lstatsFor(100, 'first')).toBe(1)
    expect(await lstatsFor(10, 'deepest')).toBe(10)
  })
})
