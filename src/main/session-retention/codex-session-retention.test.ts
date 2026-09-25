import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claimsCodexRolloutLayout } from '../codex/codex-session-resume-home'
import {
  applyCodexSessionRetention,
  isPrivateCodexRolloutPath,
  listPrivateCodexSessionRoots,
  type CodexSessionRetentionPolicy
} from './codex-session-retention'

const NOW = Date.parse('2026-09-21T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-retention-'))
  roots.push(root)
  return root
}

function writeRollout(
  sessionsDir: string,
  day: string,
  name: string,
  bytes: number,
  ageMs: number
): string {
  const dir = join(sessionsDir, '2026', day.slice(0, 2), day.slice(2))
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, 'x'.repeat(bytes))
  const mtime = new Date(NOW - ageMs)
  utimesSync(file, mtime, mtime)
  return file
}

describe('isPrivateCodexRolloutPath', () => {
  it('matches the Codex resume layout check', () => {
    const samples = [
      '/Users/ada/sessions/2026/07/20/rollout-session.jsonl',
      '/Users/ada/sessions/2026/07/20/rollout-session.jsonl.zst',
      'C:\\Users\\ada\\sessions\\2026\\07\\20\\rollout-a.jsonl',
      '/Users/ada/sessions/index.jsonl',
      '/Users/ada/sessions/2026/07/20/nested/rollout-a.jsonl',
      '/Users/ada/auth.json'
    ]
    for (const sample of samples) {
      expect(isPrivateCodexRolloutPath(sample)).toBe(claimsCodexRolloutLayout(sample))
    }
  })
})

describe('applyCodexSessionRetention', () => {
  it('removes rollouts older than the age cutoff and keeps recent ones', async () => {
    const sessions = join(tempRoot(), 'codex-runtime-home', 'home', 'sessions')
    const home = join(sessions, '..')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'auth.json'), '{"token":"keep"}')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'index.jsonl'), '{"not":"a rollout"}\n')
    const oldFile = writeRollout(sessions, '0501', 'rollout-old.jsonl', 20, 40 * DAY)
    const recentFile = writeRollout(sessions, '0901', 'rollout-recent.jsonl', 20, 2 * DAY)
    writeRollout(sessions, '0801', 'rollout-compressed.jsonl.zst', 20, 2 * DAY)

    const result = await applyCodexSessionRetention({
      sessionsDir: sessions,
      policy: policy({ maxAgeMs: 30 * DAY, maxBytes: 1024, minKeepMs: DAY })
    })

    expect(existsSync(oldFile)).toBe(false)
    expect(existsSync(recentFile)).toBe(true)
    expect(existsSync(join(sessions, '2026', '08', '01', 'rollout-compressed.jsonl.zst'))).toBe(
      true
    )
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain('keep')
    expect(existsSync(join(sessions, 'index.jsonl'))).toBe(true)
    expect(existsSync(join(sessions, '2026', '05'))).toBe(false)
    expect(result.removedFiles).toBe(1)
    expect(result.keptFiles).toBe(2)
  })

  it('drops the oldest rollouts past the size cap and keeps files newer than one day', async () => {
    const sessions = join(tempRoot(), 'sessions')
    mkdirSync(sessions, { recursive: true })
    const oldest = writeRollout(sessions, '0601', 'rollout-oldest.jsonl', 100, 10 * DAY)
    const middle = writeRollout(sessions, '0701', 'rollout-middle.jsonl', 100, 8 * DAY)
    const fresh = writeRollout(sessions, '0910', 'rollout-fresh.jsonl', 100, 60 * 60 * 1000)

    const result = await applyCodexSessionRetention({
      sessionsDir: sessions,
      policy: policy({ maxAgeMs: 30 * DAY, maxBytes: 150, minKeepMs: DAY })
    })

    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(middle)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
    expect(result.keptFiles).toBe(1)
    expect(result.remainingOverCapBytes).toBe(0)
  })

  it('does not follow a symlink out of the sessions directory', async () => {
    const root = tempRoot()
    const sessions = join(root, 'home', 'sessions')
    const outside = join(root, 'outside')
    mkdirSync(join(outside, '2026', '01', '01'), { recursive: true })
    const outsideFile = join(outside, '2026', '01', '01', 'rollout-secret.jsonl')
    writeFileSync(outsideFile, 'secret')
    mkdirSync(sessions, { recursive: true })
    symlinkSync(outside, join(sessions, 'linked'), 'dir')

    await applyCodexSessionRetention({
      sessionsDir: sessions,
      policy: policy({ maxAgeMs: DAY, maxBytes: 1, minKeepMs: 0 })
    })

    expect(existsSync(outsideFile)).toBe(true)
    expect(lstatSync(join(sessions, 'linked')).isSymbolicLink()).toBe(true)
  })
})

describe('listPrivateCodexSessionRoots', () => {
  it('finds the shared runtime home and per-account homes, not a symlinked account', () => {
    const userData = tempRoot()
    const shared = join(userData, 'codex-runtime-home', 'home', 'sessions')
    const account = join(userData, 'codex-accounts', 'acct-1', 'home', 'sessions')
    mkdirSync(shared, { recursive: true })
    mkdirSync(account, { recursive: true })
    symlinkSync(account, join(userData, 'codex-accounts', 'linked-acct'), 'dir')

    expect(listPrivateCodexSessionRoots(userData).sort()).toEqual([account, shared].sort())
  })
})

function policy(overrides: Partial<CodexSessionRetentionPolicy>): CodexSessionRetentionPolicy {
  return {
    now: NOW,
    maxAgeMs: 30 * DAY,
    maxBytes: 2 * 1024 * 1024 * 1024,
    minKeepMs: DAY,
    ...overrides
  }
}
