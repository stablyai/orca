import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcadTerminalRestoreHintStore } from './orcad-terminal-restore-hint-store'

const failNextRead = vi.hoisted((): { code: string | null } => ({ code: null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const readFileSync = (...args: Parameters<typeof actual.readFileSync>) => {
    const code = failNextRead.code
    if (code) {
      failNextRead.code = null
      throw Object.assign(new Error(`${code}: read failed`), { code })
    }
    return actual.readFileSync(...args)
  }
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})

let root: string
let storePath: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcad-restore-hints-'))
  storePath = join(root, 'installed', 'terminal-restore-hints.json')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const migration = (suffix: string) => ({
  migrationKey: suffix.repeat(32),
  migrationId: `m-${suffix}`
})
const worktreeId = 'repo::/home/user/project'
const paneA = 'tab-a:11111111-1111-4111-8111-111111111111'
const paneB = 'tab-b:22222222-2222-4222-8222-222222222222'
const hint = (paneKey: string) => ({ paneKey, cwd: '/home/user/project', worktreeId })

describe('orcad terminal restore hint store', () => {
  it('keeps existing hints when a read fails transiently', () => {
    new OrcadTerminalRestoreHintStore(root).install(migration('a'), [hint(paneA)], 1000)
    const store = new OrcadTerminalRestoreHintStore(root)
    failNextRead.code = 'EIO'
    expect(store.peek(paneA, worktreeId, 2000)).toBeNull()
    failNextRead.code = 'EIO'
    expect(() => store.consume(paneA, 2000)).not.toThrow()
    failNextRead.code = 'EIO'
    expect(() => store.install(migration('b'), [hint(paneB)], 2000)).toThrow(
      expect.objectContaining({ code: 'EIO' })
    )

    store.install(migration('b'), [hint(paneB)], 2000)
    const reloaded = new OrcadTerminalRestoreHintStore(root)
    expect(reloaded.peek(paneA, worktreeId, 2001)).toBe('/home/user/project')
    expect(reloaded.peek(paneB, worktreeId, 2001)).toBe('/home/user/project')
    expect(reloaded.hasInstalledMigration(migration('a').migrationKey)).toBe(true)
  })

  // chmod cannot deny the owner a read on Windows or as root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps a permission-denied store and reads it again once access returns',
    () => {
      new OrcadTerminalRestoreHintStore(root).install(migration('a'), [hint(paneA)], 1000)
      chmodSync(storePath, 0o000)

      const store = new OrcadTerminalRestoreHintStore(root)
      expect(store.peek(paneA, worktreeId, 2000)).toBeNull()
      expect(() => store.install(migration('b'), [hint(paneB)], 2000)).toThrow(
        expect.objectContaining({ code: 'EACCES' })
      )
      chmodSync(storePath, 0o600)

      store.install(migration('b'), [hint(paneB)], 2000)
      const reloaded = new OrcadTerminalRestoreHintStore(root)
      expect(reloaded.peek(paneA, worktreeId, 2001)).toBe('/home/user/project')
      expect(reloaded.peek(paneB, worktreeId, 2001)).toBe('/home/user/project')
    }
  )

  it('never replaces a store written by a newer build', () => {
    mkdirSync(dirname(storePath), { recursive: true })
    const text = '{"version":3,"hints":[]}'
    writeFileSync(storePath, text)

    const store = new OrcadTerminalRestoreHintStore(root)
    expect(store.peek(paneB, worktreeId, 2000)).toBeNull()
    expect(() => store.install(migration('b'), [hint(paneB)], 2000)).toThrow(/newer Orca build/)
    expect(readFileSync(storePath, 'utf8')).toBe(text)
  })
})
