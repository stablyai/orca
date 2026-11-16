import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GUEST_MEASURE_HISTORY_SCRIPT,
  GUEST_REMOVE_KEEPING_HISTORY_SCRIPT,
  measureRetainedClaudeHistory,
  removeClaudeProfileFolder
} from './claude-profile-retained-history'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

// Links as Orca makes them: junctions and a hardlinked prompt history on Windows.
function linkFolder(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

// The guest scripts take paths as arguments; quotes and spaces must not split or expand them.
function fixture(name = process.platform === 'win32' ? "it's a folder" : `it's a "folder"`) {
  const root = mkdtempSync(join(tmpdir(), 'claude-retained-'))
  roots.push(root)
  const systemDefault = join(root, 'user', '.claude')
  write(join(systemDefault, 'projects', 'shared', 'chat.jsonl'), 'shared chat')
  write(join(systemDefault, 'history.jsonl'), 'shared prompts\n')
  write(join(systemDefault, 'plugins', 'plugin.json'), '{}')
  const other = join(root, name, 'claude-profiles', 'b', 'home')
  write(join(other, 'projects.orca-profile-merge', 'p', 'b.jsonl'), 'other account')
  const folder = join(root, name, 'claude-profiles', 'a')
  const home = join(folder, 'home')
  // Account-only history: 10 + 5 + 7 bytes.
  write(join(home, 'projects.orca-profile-merge', 'p', 'conflict.jsonl'), '0123456789')
  write(join(home, 'todos', 't.json'), 'todo!')
  write(join(home, 'history.jsonl.orca-profile-merge-1'), 'prompt\n')
  linkFolder(join(systemDefault, 'projects'), join(home, 'projects'))
  if (process.platform === 'win32') {
    linkSync(join(systemDefault, 'history.jsonl'), join(home, 'history.jsonl'))
  } else {
    symlinkSync(join(systemDefault, 'history.jsonl'), join(home, 'history.jsonl'))
  }
  linkFolder(join(systemDefault, 'projects'), join(home, 'file-history'))
  write(join(home, '.credentials.json'), 'fixture-not-a-secret')
  write(join(home, '.claude.json'), '{"oauthAccount":{"emailAddress":"a@example.test"}}')
  write(join(home, 'settings.json'), '{}')
  mkdirSync(join(home, 'plugins'))
  linkFolder(join(systemDefault, 'plugins'), join(home, 'plugins', 'shared'))
  write(join(folder, 'profile.json'), '{}')
  return { root, systemDefault, other, folder, home }
}

function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name)
      files[path.slice(dir.length)] = readFileSync(path, 'utf8')
    }
  }
  return files
}

function runGuestScript(script: string, args: string[]) {
  return spawnSync('bash', ['-c', script, 'bash', ...args], { encoding: 'utf8' })
}

type Fixture = ReturnType<typeof fixture>

function expectKept(f: Fixture, sharedBefore: Record<string, string>, otherBefore: object) {
  expect(readdirSync(f.folder)).toEqual(['home'])
  expect(readdirSync(f.home).sort()).toEqual([
    'history.jsonl.orca-profile-merge-1',
    'projects.orca-profile-merge',
    'todos'
  ])
  expect(
    readFileSync(join(f.home, 'projects.orca-profile-merge', 'p', 'conflict.jsonl'), 'utf8')
  ).toBe('0123456789')
  expect(snapshot(f.systemDefault)).toEqual(sharedBefore)
  expect(snapshot(f.other)).toEqual(otherBefore)
}

function expectDeleted(f: Fixture, sharedBefore: Record<string, string>, otherBefore: object) {
  expect(existsSync(f.folder)).toBe(false)
  expect(snapshot(f.systemDefault)).toEqual(sharedBefore)
  expect(snapshot(f.other)).toEqual(otherBefore)
}

describe('Claude account retained history', () => {
  it('measures only the bytes this account alone holds', async () => {
    const f = fixture()
    await expect(measureRetainedClaudeHistory(f.folder)).resolves.toBe(22)
  })

  it('keeps retained conversations but removes the sign-in, settings and links', async () => {
    const f = fixture()
    const shared = snapshot(f.systemDefault)
    const other = snapshot(f.other)
    await removeClaudeProfileFolder(f.folder, { deleteRetainedHistory: false })
    expectKept(f, shared, other)
  })

  it('deletes retained conversations only when asked, never through links', async () => {
    const f = fixture()
    const shared = snapshot(f.systemDefault)
    const other = snapshot(f.other)
    await removeClaudeProfileFolder(f.folder, { deleteRetainedHistory: true })
    expectDeleted(f, shared, other)
  })

  it('treats a hardlink to the shared prompt history as shared', async () => {
    const f = fixture()
    rmSync(join(f.home, 'history.jsonl'))
    linkSync(join(f.systemDefault, 'history.jsonl'), join(f.home, 'history.jsonl'))
    await expect(measureRetainedClaudeHistory(f.folder)).resolves.toBe(22)
    await removeClaudeProfileFolder(f.folder, { deleteRetainedHistory: false })
    expect(existsSync(join(f.home, 'history.jsonl'))).toBe(false)
    expect(readFileSync(join(f.systemDefault, 'history.jsonl'), 'utf8')).toBe('shared prompts\n')
  })

  // Windows ignores the mode, and root reads anything.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails the measurement rather than undercount',
    async () => {
      const f = fixture()
      chmodSync(join(f.home, 'projects.orca-profile-merge', 'p'), 0o000)
      try {
        await expect(measureRetainedClaudeHistory(f.folder)).rejects.toThrow()
      } finally {
        chmodSync(join(f.home, 'projects.orca-profile-merge', 'p'), 0o700)
      }
    }
  )

  // The guest scripts need GNU find and stat.
  describe.skipIf(process.platform !== 'linux')('in a WSL guest', () => {
    it('measures the same bytes', () => {
      const f = fixture()
      const result = runGuestScript(GUEST_MEASURE_HISTORY_SCRIPT, [f.folder])
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('22')
    })

    it('keeps retained conversations by default', () => {
      const f = fixture()
      const shared = snapshot(f.systemDefault)
      const other = snapshot(f.other)
      expect(runGuestScript(GUEST_REMOVE_KEEPING_HISTORY_SCRIPT, [f.folder, 'keep']).status).toBe(0)
      expectKept(f, shared, other)
    })

    it('deletes them only when asked', () => {
      const f = fixture()
      const shared = snapshot(f.systemDefault)
      const other = snapshot(f.other)
      expect(runGuestScript(GUEST_REMOVE_KEEPING_HISTORY_SCRIPT, [f.folder, 'delete']).status).toBe(
        0
      )
      expectDeleted(f, shared, other)
    })
  })
})
