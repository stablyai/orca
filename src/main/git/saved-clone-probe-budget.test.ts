import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { runGitProbeOnHost } from '../repo-git-remote-identity'
import { reuseSavedCloneTarget } from './saved-clone-target'

vi.mock('../repo-git-remote-identity', () => ({ runGitProbeOnHost: vi.fn() }))

const url = 'https://gitlab.example.com/team/orca.git'
const project: Repo = {
  id: 'saved',
  path: '/repos/orca',
  displayName: 'orca',
  badgeColor: '#fff',
  addedAt: 1,
  kind: 'git'
}
const missingHead = Object.assign(new Error('Git returned no matching revision'), {
  code: 1,
  stderr: ''
})
const probe = vi.mocked(runGitProbeOnHost)
const decide = (signal?: AbortSignal) =>
  reuseSavedCloneTarget(() => project, url, 'ssh:fixture', signal)

beforeEach(() => {
  probe.mockReset()
})
afterEach(() => vi.useRealTimers())

describe('saved clone probe budget', () => {
  it('does no Git reads for a new clone or a folder workspace', async () => {
    await expect(reuseSavedCloneTarget(() => undefined, url, 'local')).resolves.toBeNull()
    await expect(
      reuseSavedCloneTarget(() => ({ ...project, kind: 'folder' }), url, 'local')
    ).resolves.toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it('uses two fixed-size reads for a finished checkout, independent of repository file count', async () => {
    probe
      .mockResolvedValueOnce({ stdout: '\nabc123\n' })
      .mockResolvedValueOnce({ stdout: `${url}\n` })
    await expect(decide()).resolves.toBe(project)
    expect(probe.mock.calls.map(([args]) => args)).toEqual([
      ['rev-parse', '--show-cdup', '--verify', '--quiet', 'HEAD'],
      ['config', '--get-all', 'remote.origin.url']
    ])
  })

  it('uses the unborn-branch fallback only after Git reports no HEAD revision', async () => {
    probe
      .mockRejectedValueOnce(missingHead)
      .mockResolvedValueOnce({ stdout: '\n' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' })
      .mockResolvedValueOnce({
        stdout: `remote.origin.url ${url}\nbranch.main.remote origin\nbranch.main.merge refs/heads/main\n`
      })
    await expect(decide()).resolves.toBe(project)
    expect(probe).toHaveBeenCalledTimes(4)
  })

  it('accepts a quiet missing HEAD through an older SSH error without relying on English text', async () => {
    probe
      .mockRejectedValueOnce(Object.assign(new Error('La commande a échoué'), { code: 1 }))
      .mockResolvedValueOnce({ stdout: '\n' })
      .mockResolvedValueOnce({ stdout: 'refs/heads/main\n' })
      .mockResolvedValueOnce({
        stdout: `remote.origin.url ${url}\nbranch.main.remote origin\nbranch.main.merge refs/heads/main\n`
      })
    await expect(decide()).resolves.toBe(project)
    expect(probe).toHaveBeenCalledTimes(4)
  })

  it('refuses the invalid HEAD left by a clone interrupted during fetch', async () => {
    probe
      .mockRejectedValueOnce(missingHead)
      .mockResolvedValueOnce({ stdout: '\n' })
      .mockRejectedValueOnce(Object.assign(new Error('fatal: No such ref: HEAD'), { code: 128 }))
    await expect(decide()).rejects.toThrow('already an Orca project')
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['transport loss', new Error('SSH channel closed')],
    ['missing cwd', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })],
    ['permission failure', Object.assign(new Error('fatal: permission denied'), { code: 128 })],
    ['unstructured failure', new Error('fatal: Needed a single revision')],
    [
      'wrapper failure',
      Object.assign(new Error('connection lost'), { code: 1, stderr: 'connection lost' })
    ]
  ])('does not retry the host after %s', async (_label, error) => {
    probe.mockRejectedValue(error)
    await expect(decide()).rejects.toThrow('already an Orca project')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('does not retry when there is no route to the host', async () => {
    probe.mockResolvedValue(null)
    await expect(decide()).rejects.toThrow('already an Orca project')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('spends one SSH timeout budget, rather than starting a second timed-out read', async () => {
    vi.useFakeTimers()
    const started = Date.now()
    probe.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () => reject(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })),
            20_000
          )
        })
    )
    const assertion = expect(decide()).rejects.toThrow('already an Orca project')
    await vi.runAllTimersAsync()
    await assertion
    expect(Date.now() - started).toBe(20_000)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('issues no later read after cancellation during the first read', async () => {
    const controller = new AbortController()
    probe.mockImplementation(async () => {
      controller.abort()
      throw new Error('cancelled')
    })
    await expect(decide(controller.signal)).rejects.toThrow('Clone aborted')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('issues no read when the caller already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(decide(controller.signal)).rejects.toThrow('Clone aborted')
    expect(probe).not.toHaveBeenCalled()
  })
})
