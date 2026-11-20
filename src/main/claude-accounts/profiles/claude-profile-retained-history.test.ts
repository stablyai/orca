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
import type * as FsPromises from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  GUEST_MEASURE_HISTORY_SCRIPT,
  GUEST_REMOVE_KEEPING_HISTORY_SCRIPT,
  measureRetainedClaudeHistory,
  removeClaudeProfileFolder
} from './claude-profile-retained-history'

// Runs a change right after a chosen directory is listed, as a concurrent writer would.
const afterListing = vi.hoisted(() => new Map<string, () => void>())
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const listing = await actual.readdir(...args)
      const change = afterListing.get(String(args[0]))
      afterListing.delete(String(args[0]))
      change?.()
      return listing
    }
  }
})

const roots: string[] = []
afterEach(() => {
  afterListing.clear()
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

// Orca hardlinks prompt history to System default's on Windows.
function linkPromptHistory(systemDefault: string, home: string): void {
  linkSync(join(systemDefault, 'history.jsonl'), join(home, 'history.jsonl'))
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
    linkPromptHistory(systemDefault, home)
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

function expectKept(
  f: Fixture,
  sharedBefore: Record<string, string>,
  otherBefore: Record<string, string>
) {
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

function expectDeleted(
  f: Fixture,
  sharedBefore: Record<string, string>,
  otherBefore: Record<string, string>
) {
  expect(existsSync(f.folder)).toBe(false)
  expect(snapshot(f.systemDefault)).toEqual(sharedBefore)
  expect(snapshot(f.other)).toEqual(otherBefore)
}

describe('Claude account retained history', () => {
  it('measures only the bytes this account alone holds', async () => {
    const f = fixture()
    await expect(measureRetainedClaudeHistory(f.folder, f.systemDefault)).resolves.toBe(22)
  })

  it('keeps retained conversations but removes the sign-in, settings and links', async () => {
    const f = fixture()
    const shared = snapshot(f.systemDefault)
    const other = snapshot(f.other)
    await removeClaudeProfileFolder(f.folder, {
      deleteRetainedHistory: false,
      sharedHome: f.systemDefault
    })
    expectKept(f, shared, other)
  })

  it('deletes retained conversations only when asked, never through links', async () => {
    const f = fixture()
    const shared = snapshot(f.systemDefault)
    const other = snapshot(f.other)
    await removeClaudeProfileFolder(f.folder, {
      deleteRetainedHistory: true,
      sharedHome: f.systemDefault
    })
    expectDeleted(f, shared, other)
  })

  it('keeps a private prompt history unless Orca linked it to the shared one', async () => {
    const f = fixture()
    rmSync(join(f.home, 'history.jsonl'))
    linkPromptHistory(f.systemDefault, f.home)
    await expect(measureRetainedClaudeHistory(f.folder, f.systemDefault)).resolves.toBe(22)
    await removeClaudeProfileFolder(f.folder, {
      deleteRetainedHistory: false,
      sharedHome: f.systemDefault
    })
    expect(existsSync(join(f.home, 'history.jsonl'))).toBe(false)
    expect(readFileSync(join(f.systemDefault, 'history.jsonl'), 'utf8')).toBe('shared prompts\n')

    // Once System default's file is replaced, the old link holds only this account's prompts.
    const h = fixture()
    rmSync(join(h.home, 'history.jsonl'))
    linkPromptHistory(h.systemDefault, h.home)
    rmSync(join(h.systemDefault, 'history.jsonl'))
    write(join(h.systemDefault, 'history.jsonl'), 'new shared\n')
    await removeClaudeProfileFolder(h.folder, {
      deleteRetainedHistory: false,
      sharedHome: h.systemDefault
    })
    expect(readFileSync(join(h.home, 'history.jsonl'), 'utf8')).toBe('shared prompts\n')

    const g = fixture()
    rmSync(join(g.home, 'history.jsonl'))
    write(join(g.home, 'history.jsonl'), 'mine\n')
    linkSync(join(g.home, 'history.jsonl'), join(g.root, 'backup.jsonl'))
    await expect(measureRetainedClaudeHistory(g.folder, g.systemDefault)).resolves.toBe(27)
    await removeClaudeProfileFolder(g.folder, {
      deleteRetainedHistory: false,
      sharedHome: g.systemDefault
    })
    expect(readFileSync(join(g.home, 'history.jsonl'), 'utf8')).toBe('mine\n')
  })

  it('removes the whole folder when the history it kept holds nothing', async () => {
    const f = fixture()
    for (const name of [
      'projects.orca-profile-merge',
      'todos',
      'history.jsonl.orca-profile-merge-1'
    ]) {
      rmSync(join(f.home, name), { recursive: true })
    }
    mkdirSync(join(f.home, 'session-env'))
    await removeClaudeProfileFolder(f.folder, {
      deleteRetainedHistory: false,
      sharedHome: f.systemDefault
    })
    expect(existsSync(f.folder)).toBe(false)
  })

  it('keeps prompt history whose shared file was replaced after the removal began', async () => {
    const f = fixture()
    rmSync(join(f.home, 'history.jsonl'))
    linkPromptHistory(f.systemDefault, f.home)
    // Replaced once the keep rules are read: the old link now holds only this account's prompts.
    afterListing.set(f.home, () => {
      rmSync(join(f.systemDefault, 'history.jsonl'))
      write(join(f.systemDefault, 'history.jsonl'), 'new shared\n')
    })
    await removeClaudeProfileFolder(f.folder, {
      deleteRetainedHistory: false,
      sharedHome: f.systemDefault
    })
    expect(readFileSync(join(f.home, 'history.jsonl'), 'utf8')).toBe('shared prompts\n')
    expect(readFileSync(join(f.systemDefault, 'history.jsonl'), 'utf8')).toBe('new shared\n')
  })

  it('never walks into a folder swapped for an outside link after it was listed', async () => {
    for (const deleteRetainedHistory of [false, true]) {
      const f = fixture()
      const outside = join(f.root, 'outside')
      mkdirSync(join(outside, 'empty'), { recursive: true })
      linkFolder(f.systemDefault, join(outside, 'link'))
      // Kept history is pruned, removed folders are unlinked: both walk into listed subfolders.
      const parent = join(f.home, deleteRetainedHistory ? 'plugins' : 'todos')
      mkdirSync(join(parent, 'sub'))
      afterListing.set(parent, () => {
        rmSync(join(parent, 'sub'), { recursive: true })
        linkFolder(outside, join(parent, 'sub'))
      })
      await removeClaudeProfileFolder(f.folder, {
        deleteRetainedHistory,
        sharedHome: f.systemDefault
      })
      expect(readdirSync(outside).sort()).toEqual(['empty', 'link'])
      expect(existsSync(join(outside, 'link', 'history.jsonl'))).toBe(true)
    }
  })

  // Windows ignores the mode, and root reads anything.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails the measurement rather than undercount',
    async () => {
      const f = fixture()
      chmodSync(join(f.home, 'projects.orca-profile-merge', 'p'), 0o000)
      try {
        await expect(measureRetainedClaudeHistory(f.folder, f.systemDefault)).rejects.toThrow()
      } finally {
        chmodSync(join(f.home, 'projects.orca-profile-merge', 'p'), 0o700)
      }
    }
  )

  // Windows ignores the mode, and root reads anything.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'still removes the sign-in when System default cannot be read',
    async () => {
      const f = fixture()
      chmodSync(f.systemDefault, 0o000)
      try {
        await removeClaudeProfileFolder(f.folder, {
          deleteRetainedHistory: false,
          sharedHome: f.systemDefault
        })
      } finally {
        chmodSync(f.systemDefault, 0o700)
      }
      expect(existsSync(join(f.home, '.credentials.json'))).toBe(false)
      expect(existsSync(join(f.home, 'projects.orca-profile-merge'))).toBe(true)
    }
  )

  // The guest scripts need GNU find.
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

    it.skipIf(process.getuid?.() === 0)('fails instead of reporting a partial result', () => {
      const f = fixture()
      chmodSync(f.home, 0o300)
      try {
        expect(runGuestScript(GUEST_MEASURE_HISTORY_SCRIPT, [f.folder]).status).not.toBe(0)
      } finally {
        chmodSync(f.home, 0o700)
      }
      chmodSync(f.home, 0o500)
      try {
        const removal = runGuestScript(GUEST_REMOVE_KEEPING_HISTORY_SCRIPT, [f.folder, 'keep'])
        expect(removal.status).not.toBe(0)
      } finally {
        chmodSync(f.home, 0o700)
      }
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
