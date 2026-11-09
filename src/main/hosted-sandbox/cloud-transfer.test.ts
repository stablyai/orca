import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() } }))

import {
  claudeProjectDirName,
  pickTransferBranchName,
  remapSessionTranscript
} from '../../shared/hosted-sandbox/cloud-transfer-pack'
import {
  importBundle,
  installSessions,
  pickCloudWorktree,
  sweepCloudTransfers
} from './cloud-transfer'

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8'
  }).trim()

describe('cloud transfer path remapping', () => {
  it('names Claude project folders like Claude Code does', () => {
    expect(claudeProjectDirName('/vercel/sandbox/project')).toBe('-vercel-sandbox-project')
    expect(claudeProjectDirName('/Users/a.b/my_repo')).toBe('-Users-a-b-my-repo')
  })

  it('rewrites whole paths and prefixes only, raw and JSON-escaped', () => {
    const line = JSON.stringify({
      cwd: '/vercel/sandbox/project',
      file: '/vercel/sandbox/project/src/a.ts',
      other: '/vercel/sandbox/project-two'
    })
    const out = JSON.parse(
      remapSessionTranscript(line, '/vercel/sandbox/project', '/Users/me/orca/ws "x"')
    )
    expect(out).toEqual({
      cwd: '/Users/me/orca/ws "x"',
      file: '/Users/me/orca/ws "x"/src/a.ts',
      other: '/vercel/sandbox/project-two'
    })
  })

  it('keeps the cloud branch name when free, else suffixes it', () => {
    expect(pickTransferBranchName('feat/x', () => false, 'f')).toBe('feat/x')
    const taken = new Set(['feat/x', 'feat/x-cloud'])
    expect(pickTransferBranchName('feat/x', (n) => taken.has(n), 'f')).toBe('feat/x-cloud-2')
    expect(pickTransferBranchName(null, () => false, 'cloud-abc')).toBe('cloud-abc')
    expect(pickTransferBranchName('bad name;rm', () => false, 'cloud-abc')).toBe('cloud-abc')
  })

  it('picks the cloud worktree by id, then project root, then the only one', () => {
    const rows = [
      { id: 'repo::a', path: '/vercel/sandbox/project' },
      { id: 'repo::b', path: '/vercel/sandbox/other' }
    ]
    expect(pickCloudWorktree(rows, 'b', null)?.id).toBe('repo::b')
    expect(pickCloudWorktree(rows, 'zzz', '/vercel/sandbox/project')?.id).toBe('repo::a')
    expect(pickCloudWorktree(rows, 'zzz', null)).toBeNull()
    expect(pickCloudWorktree([rows[1]!], 'zzz', null)?.id).toBe('repo::b')
  })
})

describe('cloud transfer import', () => {
  it('fetches the bundle into a free branch and installs remapped sessions without overwriting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-transfer-'))
    const cloud = join(root, 'cloud')
    const local = join(root, 'local')
    mkdirSync(cloud)
    git(cloud, 'init', '-q', '-b', 'feature')
    writeFileSync(join(cloud, 'a.txt'), 'one\n')
    git(cloud, 'add', '.')
    git(cloud, 'commit', '-qm', 'one')
    const head = git(cloud, 'rev-parse', 'HEAD')
    git(cloud, 'bundle', 'create', join(root, 'repo.bundle'), 'HEAD', 'refs/heads/feature')
    mkdirSync(local)
    git(local, 'init', '-q', '-b', 'main')
    git(local, 'commit', '-q', '--allow-empty', '-m', 'base')
    git(local, 'branch', 'feature')
    const manifest = {
      version: 1 as const,
      root: '/vercel/sandbox/project',
      branch: 'feature',
      head,
      upstream: null,
      hasBundle: true,
      stagedBytes: 0,
      unstagedBytes: 0,
      untrackedFiles: 0,
      claudeSessions: 1,
      codexSessions: 0
    }
    const branch = await importBundle(local, join(root, 'repo.bundle'), manifest)
    expect(branch).toBe('feature-cloud')
    expect(git(local, 'rev-parse', `refs/heads/${branch}`)).toBe(head)
    // Same commit already local: reuse the name.
    git(local, 'branch', '-f', 'feature', head)
    expect(await importBundle(local, join(root, 'repo.bundle'), manifest)).toBe('feature')
    // Checked out in a worktree already (moved before): a fresh name instead.
    git(local, 'worktree', 'add', '-q', join(root, 'wt-feature'), 'feature')
    expect(await importBundle(local, join(root, 'repo.bundle'), manifest)).toBe('feature-cloud-2')

    const sessions = join(root, 'sessions')
    mkdirSync(sessions)
    writeFileSync(
      join(sessions, 's1.jsonl'),
      `${JSON.stringify({ cwd: '/vercel/sandbox/project' })}\n`
    )
    const target = join(root, 'claude', 'projects', claudeProjectDirName('/Users/me/ws'))
    expect(await installSessions(sessions, target, '/vercel/sandbox/project', '/Users/me/ws')).toBe(
      1
    )
    expect(JSON.parse(readFileSync(join(target, 's1.jsonl'), 'utf8')).cwd).toBe('/Users/me/ws')
    expect(
      await installSessions(sessions, target, '/vercel/sandbox/project', '/Users/me/other')
    ).toBe(0)
  })
})

describe('cloud transfer housekeeping', () => {
  it('sweeps abandoned transfer dirs at startup but keeps recent unapplied patches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-sweep-'))
    mkdirSync(join(root, 'abandoned'))
    writeFileSync(join(root, 'abandoned', 'transfer.tar'), 'x')
    mkdirSync(join(root, 'kept', 'unapplied'), { recursive: true })
    expect(await sweepCloudTransfers(root, Date.now())).toBe(1)
    expect(await sweepCloudTransfers(root, Date.now() + 31 * 86_400_000)).toBe(1)
    expect(await sweepCloudTransfers(join(root, 'missing'), Date.now())).toBe(0)
  })

  it('installs only session transcripts, never other files from the project folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-sessions-'))
    const source = join(root, 'src')
    mkdirSync(join(source, 'memory'), { recursive: true })
    writeFileSync(join(source, 's.jsonl'), '{}\n')
    writeFileSync(join(source, 'memory', 'notes.md'), 'x')
    expect(await installSessions(source, join(root, 'out'), '/a', '/b')).toBe(1)
    expect(readFileSync(join(root, 'out', 's.jsonl'), 'utf8')).toBe('{}\n')
    expect(() => readFileSync(join(root, 'out', 'memory', 'notes.md'))).toThrow()
  })
})
