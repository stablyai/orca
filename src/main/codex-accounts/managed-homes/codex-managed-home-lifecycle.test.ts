import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexManagedHomeLifecycle } from './codex-managed-home-lifecycle'
import type { CodexManagedHomePath } from './codex-managed-home-path'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-home-removal-')))
  roots.push(root)
  const accountsRoot = join(root, 'codex-accounts')
  const home = join(accountsRoot, 'a', 'home')
  const store = join(root, '.codex')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(store, 'sessions'), { recursive: true })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: safeRemove reads only these two members.
  const paths = {
    assert: async (candidate: string) => candidate,
    getRoot: () => accountsRoot
  } as unknown as CodexManagedHomePath
  return { home, store, accountsRoot, lifecycle: new CodexManagedHomeLifecycle(paths) }
}

describe('CodexManagedHomeLifecycle.safeRemove', () => {
  it("removes the login but keeps the account's history links and conflicting copies", async () => {
    const f = fixture()
    writeFileSync(join(f.store, 'sessions', 'rollout.jsonl'), 'shared\n')
    symlinkSync(
      join(f.store, 'sessions'),
      join(f.home, 'sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    mkdirSync(join(f.home, 'sessions.orca-profile-merge'))
    writeFileSync(join(f.home, 'sessions.orca-profile-merge', 'rollout.jsonl'), 'diverged\n')
    writeFileSync(join(f.home, 'auth.json'), '{}')
    mkdirSync(join(f.home, 'log'))

    await f.lifecycle.safeRemove(f.home, 'a')

    expect(readdirSync(f.home).sort()).toEqual(['sessions', 'sessions.orca-profile-merge'])
    expect(readFileSync(join(f.home, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('shared\n')
    expect(readFileSync(join(f.store, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('shared\n')
  })

  it('keeps history that never moved into the store', async () => {
    const f = fixture()
    mkdirSync(join(f.home, 'sessions'))
    writeFileSync(join(f.home, 'sessions', 'rollout.jsonl'), 'only copy\n')
    writeFileSync(join(f.home, 'history.jsonl'), '{"text":"only prompt"}\n')
    writeFileSync(join(f.home, 'auth.json'), '{}')

    await f.lifecycle.safeRemove(f.home, 'a')

    expect(readdirSync(f.home).sort()).toEqual(['history.jsonl', 'sessions'])
    expect(readFileSync(join(f.home, 'history.jsonl'), 'utf8')).toBe('{"text":"only prompt"}\n')
    expect(readFileSync(join(f.home, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('only copy\n')
  })

  it('removes a home that never shared history entirely', async () => {
    const f = fixture()
    writeFileSync(join(f.home, 'auth.json'), '{}')

    await f.lifecycle.safeRemove(f.home, 'a')

    expect(existsSync(join(f.accountsRoot, 'a'))).toBe(false)
  })
})
