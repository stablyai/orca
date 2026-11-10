import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { materializeCodexSessionDeletionSymlinks } from './codex-session-delete-symlinks'

const hooks = vi.hoisted(() => ({ copied: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  return {
    ...original,
    copyFile: async (...args: Parameters<typeof original.copyFile>) => {
      await original.copyFile(...args)
      hooks.copied(args[1])
    }
  }
})
vi.mock('../../../ai-vault/cached-session-list', () => ({
  configuredAdditionalCodexHomePaths: () => []
}))

const SESSION = '019f0000-1111-7222-8333-000000000001'
const OTHER = '019f0000-1111-7222-8333-000000000002'
let root: string
let homes: string[]
let target: string
let alias: string

function metadata(id: string): string {
  return `${JSON.stringify({ type: 'session_meta', payload: { id } })}\n`
}

beforeEach(() => {
  hooks.copied.mockReset()
  root = mkdtempSync(join(tmpdir(), 'orca-codex-alias-'))
  homes = ['system', 'account'].map((name) => join(root, name))
  const filename = `rollout-2026-10-11T12-00-00-${SESSION}.jsonl`
  target = join(homes[0], 'sessions', filename)
  alias = join(homes[1], 'sessions', filename)
  homes.forEach((home) => mkdirSync(join(home, 'sessions'), { recursive: true }))
  writeFileSync(target, metadata(SESSION))
  symlinkSync(target, alias, 'file')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

it('does not replace an alias that changes during copying', async () => {
  hooks.copied.mockImplementation(() => {
    rmSync(alias)
    writeFileSync(alias, 'keep this replacement')
  })
  await expect(
    materializeCodexSessionDeletionSymlinks(
      SESSION,
      [{ home: homes[1], filePath: alias, target }],
      homes
    )
  ).rejects.toThrow()
  expect(readFileSync(alias, 'utf8')).toBe('keep this replacement')
  expect(readFileSync(target, 'utf8')).toBe(metadata(SESSION))
  expect(readdirSync(dirname(alias))).toEqual([alias.split(/[\\/]/).at(-1)])
})

it('rejects a copied transcript whose UUID changed and removes its temporary data', async () => {
  hooks.copied.mockImplementation((temporary: string) => writeFileSync(temporary, metadata(OTHER)))
  await expect(
    materializeCodexSessionDeletionSymlinks(
      SESSION,
      [{ home: homes[1], filePath: alias, target }],
      homes
    )
  ).rejects.toThrow('identity changed')
  expect(readFileSync(alias, 'utf8')).toBe(metadata(SESSION))
  expect(readdirSync(dirname(alias))).toEqual([alias.split(/[\\/]/).at(-1)])
})

it('materializes a physical alias only once when homes share a directory', async () => {
  const homeAlias = join(root, 'account-alias')
  symlinkSync(homes[1], homeAlias, process.platform === 'win32' ? 'junction' : 'dir')
  await materializeCodexSessionDeletionSymlinks(
    SESSION,
    [
      { home: homes[1], filePath: alias, target },
      {
        home: homeAlias,
        filePath: join(homeAlias, 'sessions', alias.split(/[\\/]/).at(-1) ?? ''),
        target
      }
    ],
    [...homes, homeAlias]
  )
  expect(hooks.copied).toHaveBeenCalledTimes(1)
  expect(readFileSync(alias, 'utf8')).toBe(metadata(SESSION))
})
