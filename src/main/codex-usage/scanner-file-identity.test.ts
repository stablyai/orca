import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { PathLike } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixture = vi.hoisted(() => ({
  root: '',
  identities: new Map<string, { dev: bigint; ino: bigint }>(),
  statErrors: new Set<string>(),
  realpathErrors: new Set<string>()
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    stat: async (filePath: PathLike, options?: { bigint?: boolean }) => {
      const path = String(filePath)
      if (fixture.statErrors.has(path)) {
        throw new Error('Fixture stat unavailable')
      }
      const identity = fixture.identities.get(path)
      if (options?.bigint) {
        const stats = await actual.stat(filePath, { bigint: true })
        return identity ? Object.assign(stats, identity) : stats
      }
      const stats = await actual.stat(filePath)
      return identity
        ? Object.assign(stats, { dev: Number(identity.dev), ino: Number(identity.ino) })
        : stats
    },
    realpath: async (filePath: PathLike) => {
      if (fixture.realpathErrors.has(String(filePath))) {
        throw new Error('Fixture realpath unavailable')
      }
      return actual.realpath(filePath)
    }
  }
})

vi.mock('../codex/codex-home-paths', () => ({
  getOrcaManagedCodexHomePath: () => join(fixture.root, 'runtime'),
  getSystemCodexHomePath: () => join(fixture.root, 'system')
}))

vi.mock('../codex/codex-account-home-discovery', () => ({
  getCodexAccountHomeSessionDirectories: () => []
}))

vi.mock('../codex/codex-session-bridge', () => ({
  getLegacyCopiedCodexSessionBridgeScanPreference: () => null
}))

import { listCodexSessionFiles } from './codex-session-file-discovery'
import { scanCodexUsageFiles } from './scanner'

function writeSession(name: string, tokens = 10): string {
  const filePath = join(fixture.root, 'runtime', 'sessions', `${name}.jsonl`)
  const records = [
    { type: 'session_meta', payload: { id: name, cwd: fixture.root } },
    {
      timestamp: '2026-09-20T12:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model: 'gpt-5-codex',
          last_token_usage: { input_tokens: tokens, total_tokens: tokens }
        }
      }
    }
  ]
  writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return filePath
}

beforeEach(() => {
  fixture.root = mkdtempSync(join(tmpdir(), 'orca-codex-file-identity-'))
  mkdirSync(join(fixture.root, 'runtime', 'sessions'), { recursive: true })
  fixture.identities.clear()
  fixture.statErrors.clear()
  fixture.realpathErrors.clear()
})

afterEach(() => {
  rmSync(fixture.root, { recursive: true, force: true })
})

describe('Codex session physical file identity', () => {
  it('keeps adjacent large inode IDs distinct when numeric stats would round them together', async () => {
    const first = writeSession('first')
    const second = writeSession('second')
    const firstIno = 2n ** 53n
    const secondIno = firstIno + 1n
    expect(Number(firstIno)).toBe(Number(secondIno))
    fixture.identities.set(first, { dev: 1n, ino: firstIno })
    fixture.identities.set(second, { dev: 1n, ino: secondIno })

    expect(await listCodexSessionFiles()).toEqual([first, second])
  })

  it('keeps the device part of the identity exact too', async () => {
    const first = writeSession('first')
    const second = writeSession('second')
    fixture.identities.set(first, { dev: 2n ** 53n, ino: 7n })
    fixture.identities.set(second, { dev: 2n ** 53n + 1n, ino: 7n })

    expect(await listCodexSessionFiles()).toEqual([first, second])
  })

  it('counts both distinct sessions and preserves numeric timestamps, sizes and cache reuse', async () => {
    const first = writeSession('first', 10)
    const second = writeSession('second', 20)
    fixture.identities.set(first, { dev: 1n, ino: 2n ** 53n })
    fixture.identities.set(second, { dev: 1n, ino: 2n ** 53n + 1n })

    const result = await scanCodexUsageFiles([], [])
    expect(result.dailyAggregates.reduce((total, row) => total + row.totalTokens, 0)).toBe(30)
    expect(result.sessions).toHaveLength(2)
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
    for (const file of result.processedFiles) {
      const stats = await actual.stat(file.path)
      expect(file.mtimeMs).toBe(stats.mtimeMs)
      expect(file.size).toBe(stats.size)
    }
    const cached = await scanCodexUsageFiles([], result.processedFiles)
    expect(cached.dailyAggregates).toEqual(result.dailyAggregates)
    expect(cached.processedFiles[0]).toBe(result.processedFiles[0])
    expect(cached.processedFiles[1]).toBe(result.processedFiles[1])
  })

  it('deduplicates real hardlink aliases across session homes', async () => {
    const original = writeSession('original')
    mkdirSync(join(fixture.root, 'system', 'sessions'), { recursive: true })
    const alias = join(fixture.root, 'system', 'sessions', 'alias.jsonl')
    linkSync(original, alias)

    expect(await listCodexSessionFiles()).toEqual([original, alias].sort().slice(0, 1))
    const result = await scanCodexUsageFiles([], [])
    expect(result.dailyAggregates.reduce((total, row) => total + row.totalTokens, 0)).toBe(10)
  })

  it('does not collapse distinct zero-inode files', async () => {
    const first = writeSession('first')
    const second = writeSession('second')
    fixture.identities.set(first, { dev: 1n, ino: 0n })
    fixture.identities.set(second, { dev: 1n, ino: 0n })

    expect(await listCodexSessionFiles()).toEqual([first, second])
  })

  it.each(['zero inode', 'stat failure'])('deduplicates canonical paths after %s', async (mode) => {
    const original = writeSession('original')
    symlinkSync(
      join(fixture.root, 'runtime'),
      join(fixture.root, 'system'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const alias = join(fixture.root, 'system', 'sessions', 'original.jsonl')
    for (const path of [original, alias]) {
      if (mode === 'zero inode') {
        fixture.identities.set(path, { dev: 1n, ino: 0n })
      } else {
        fixture.statErrors.add(path)
      }
    }

    expect(await listCodexSessionFiles()).toEqual([original, alias].sort().slice(0, 1))
  })

  it('preserves path spelling when both stat and realpath are unavailable', async () => {
    const first = writeSession('MiXeD-first')
    const second = writeSession('MiXeD-second')
    for (const path of [first, second]) {
      fixture.statErrors.add(path)
      fixture.realpathErrors.add(path)
    }

    expect(await listCodexSessionFiles()).toEqual([first, second])
  })
})
