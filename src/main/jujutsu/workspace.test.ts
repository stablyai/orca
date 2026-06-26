import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { commandExecFileAsyncMock } = vi.hoisted(() => ({
  commandExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  commandExecFileAsync: commandExecFileAsyncMock
}))

import {
  addJujutsuWorkspace,
  forgetJujutsuWorkspace,
  isColocatedJujutsuRepo,
  isJujutsuRepo,
  jujutsuWorkspaceRoot,
  listJujutsuWorkspaces,
  shouldUseJujutsuWorkspace
} from './workspace'

let tmp: string

beforeEach(async () => {
  commandExecFileAsyncMock.mockReset()
  tmp = await mkdtemp(join(tmpdir(), 'orca-jj-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('jj repo detection', () => {
  it('detects a pure jj repo by its .jj directory', async () => {
    await mkdir(join(tmp, '.jj'))
    expect(await isJujutsuRepo(tmp)).toBe(true)
    expect(await isColocatedJujutsuRepo(tmp)).toBe(false)
    expect(await shouldUseJujutsuWorkspace(tmp)).toBe(true)
  })

  it('treats a colocated repo as git-managed, not a jj-workspace target', async () => {
    await mkdir(join(tmp, '.jj'))
    await mkdir(join(tmp, '.git'))
    expect(await isJujutsuRepo(tmp)).toBe(true)
    expect(await isColocatedJujutsuRepo(tmp)).toBe(true)
    // Colocated repos must keep using git worktrees to preserve status/diff.
    expect(await shouldUseJujutsuWorkspace(tmp)).toBe(false)
  })

  it('recognises a colocated repo whose .git is a gitfile, not a directory', async () => {
    await mkdir(join(tmp, '.jj'))
    await writeFile(join(tmp, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n')
    expect(await isColocatedJujutsuRepo(tmp)).toBe(true)
    expect(await shouldUseJujutsuWorkspace(tmp)).toBe(false)
  })

  it('reports a plain git repo as neither jj nor a jj-workspace target', async () => {
    await mkdir(join(tmp, '.git'))
    expect(await isJujutsuRepo(tmp)).toBe(false)
    expect(await shouldUseJujutsuWorkspace(tmp)).toBe(false)
  })
})

describe('addJujutsuWorkspace', () => {
  it('runs `jj workspace add` with a derived name and translated base revision', async () => {
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })
    await addJujutsuWorkspace({
      repoPath: '/repo',
      worktreePath: '/repo/.worktrees/feature',
      baseRef: 'origin/main'
    })
    expect(commandExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(commandExecFileAsyncMock).toHaveBeenCalledWith(
      'jj',
      [
        'workspace',
        'add',
        '--name',
        'feature',
        '--revision',
        'main@origin',
        '/repo/.worktrees/feature'
      ],
      { cwd: '/repo' }
    )
  })

  it('honours an explicit name and omits the revision when no base is given', async () => {
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })
    await addJujutsuWorkspace({
      repoPath: '/repo',
      worktreePath: '/repo/.worktrees/feature',
      name: 'custom'
    })
    expect(commandExecFileAsyncMock).toHaveBeenCalledWith(
      'jj',
      ['workspace', 'add', '--name', 'custom', '/repo/.worktrees/feature'],
      { cwd: '/repo' }
    )
  })
})

describe('listJujutsuWorkspaces', () => {
  it('parses tab-separated workspace output', async () => {
    commandExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'default\t/repo\nfeature\t/repo/.worktrees/feature\n',
      stderr: ''
    })
    expect(await listJujutsuWorkspaces('/repo')).toEqual([
      { name: 'default', path: '/repo' },
      { name: 'feature', path: '/repo/.worktrees/feature' }
    ])
    expect(commandExecFileAsyncMock).toHaveBeenCalledWith(
      'jj',
      ['workspace', 'list', '--template', expect.any(String)],
      { cwd: '/repo' }
    )
  })
})

describe('forgetJujutsuWorkspace', () => {
  it('runs `jj workspace forget <name>`', async () => {
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })
    await forgetJujutsuWorkspace('/repo', 'feature')
    expect(commandExecFileAsyncMock).toHaveBeenCalledWith(
      'jj',
      ['workspace', 'forget', 'feature'],
      {
        cwd: '/repo'
      }
    )
  })
})

describe('jujutsuWorkspaceRoot', () => {
  it('returns the trimmed root path', async () => {
    commandExecFileAsyncMock.mockResolvedValueOnce({ stdout: '/repo\n', stderr: '' })
    expect(await jujutsuWorkspaceRoot('/repo/sub')).toBe('/repo')
  })

  it('returns null when jj is unavailable or the path is not a jj repo', async () => {
    commandExecFileAsyncMock.mockRejectedValueOnce(new Error('command not found: jj'))
    expect(await jujutsuWorkspaceRoot('/repo')).toBeNull()
  })
})
