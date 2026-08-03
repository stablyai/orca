import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stopWorkspaceService } from './workspace-service-stop'
import { isMissingDirectory } from './workspace-directory-presence'

const SEP = '\u0001'

let root: string

function dockerRow(fields: string[]): string {
  return fields.join(SEP)
}

function containerScan(containerId: string, workingDir: string | null): string {
  return dockerRow([
    containerId,
    'db-1',
    'postgres:16',
    '0.0.0.0:5432->5432/tcp',
    'proj',
    workingDir ?? '<no value>',
    'running'
  ])
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'orca-service-stop-'))
})

afterEach(async () => {
  vi.clearAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('stopWorkspaceService — container ownership', () => {
  it('stops a container whose compose directory belongs to a known workspace', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: containerScan('aaaaaaaaaaaa', path.join(root, 'apps/api')) })
      .mockResolvedValueOnce({ stdout: '' })

    const result = await stopWorkspaceService(
      [{ id: 'wt-1', repoId: 'repo-1', displayName: 'wt', path: root }],
      { kind: 'container', containerId: 'aaaaaaaaaaaa' },
      runCommand
    )

    expect(result).toEqual({ ok: true })
    expect(runCommand.mock.calls[1][1]).toEqual(['stop', 'aaaaaaaaaaaa'])
  })

  it('matches a short request id against a full-length scanned id', async () => {
    // Docker reports 64-char ids; the scan keeps the short form. Fixtures that
    // are already 12 chars make the truncation a no-op and hide this path.
    const fullId = 'a'.repeat(64)
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: containerScan(fullId, path.join(root, 'apps/api')) })
      .mockResolvedValueOnce({ stdout: '' })

    const result = await stopWorkspaceService(
      [{ id: 'wt-1', repoId: 'repo-1', displayName: 'wt', path: root }],
      { kind: 'container', containerId: 'a'.repeat(12) },
      runCommand
    )

    expect(result).toEqual({ ok: true })
  })

  it('matches a full-length request id against the short scanned id', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({ stdout: containerScan('bbbbbbbbbbbb', path.join(root, 'apps/api')) })
      .mockResolvedValueOnce({ stdout: '' })

    const result = await stopWorkspaceService(
      [{ id: 'wt-1', repoId: 'repo-1', displayName: 'wt', path: root }],
      { kind: 'container', containerId: 'b'.repeat(64) },
      runCommand
    )

    expect(result).toEqual({ ok: true })
  })

  it('refuses a live container that belongs to no known workspace', async () => {
    // Without this the renderer could stop any container on the machine, since
    // the id only has to look like a docker id to pass the shape check. The
    // directory must exist, otherwise this is the orphan case instead.
    const unrelated = await mkdtemp(path.join(tmpdir(), 'orca-unrelated-'))
    const runCommand = vi
      .fn()
      .mockResolvedValue({ stdout: containerScan('bbbbbbbbbbbb', unrelated) })

    try {
      const result = await stopWorkspaceService(
        [{ id: 'wt-1', repoId: 'repo-1', displayName: 'wt', path: root }],
        { kind: 'container', containerId: 'bbbbbbbbbbbb' },
        runCommand
      )

      expect(result).toEqual({
        ok: false,
        reason: 'Only containers owned by a workspace can be stopped here.'
      })
      expect(runCommand).toHaveBeenCalledTimes(1)
    } finally {
      await rm(unrelated, { recursive: true, force: true })
    }
  })

  it('stops an orphan whose compose directory no longer exists', async () => {
    const runCommand = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: containerScan('cccccccccccc', path.join(root, 'deleted-worktree'))
      })
      .mockResolvedValueOnce({ stdout: '' })

    const result = await stopWorkspaceService(
      [],
      { kind: 'container', containerId: 'cccccccccccc' },
      runCommand
    )

    expect(result).toEqual({ ok: true })
  })

  it('refuses a container with no compose working directory', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: containerScan('dddddddddddd', null) })

    const result = await stopWorkspaceService(
      [],
      { kind: 'container', containerId: 'dddddddddddd' },
      runCommand
    )

    expect(result.ok).toBe(false)
  })

  it('rejects a malformed container id before running anything', async () => {
    const runCommand = vi.fn()

    const result = await stopWorkspaceService(
      [],
      { kind: 'container', containerId: 'not-hex; rm -rf /' },
      runCommand
    )

    expect(result).toEqual({ ok: false, reason: 'Invalid container id.' })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('reports a container that is no longer running', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '' })

    const result = await stopWorkspaceService(
      [],
      { kind: 'container', containerId: 'eeeeeeeeeeee' },
      runCommand
    )

    expect(result).toEqual({ ok: false, reason: 'The container is no longer running.' })
  })

  it('surfaces docker being unavailable instead of claiming the container is gone', async () => {
    const runCommand = vi.fn().mockRejectedValue(new Error('spawn docker ENOENT'))

    const result = await stopWorkspaceService(
      [],
      { kind: 'container', containerId: 'ffffffffffff' },
      runCommand
    )

    expect(result).toEqual({ ok: false, reason: 'Docker is not installed.' })
  })
})

describe('isMissingDirectory', () => {
  it('is false for a directory that exists', async () => {
    expect(await isMissingDirectory(root)).toBe(false)
  })

  it('is true for a path that does not exist', async () => {
    expect(await isMissingDirectory(path.join(root, 'gone'))).toBe(true)
  })

  it('is true when a path component is not a directory', async () => {
    // ENOTDIR: the workspace really is not reachable as a directory.
    const { writeFile } = await import('node:fs/promises')
    const file = path.join(root, 'file')
    await writeFile(file, '', 'utf-8')

    expect(await isMissingDirectory(path.join(file, 'child'))).toBe(true)
  })
})
