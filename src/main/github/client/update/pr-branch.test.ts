import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  exec: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn()
}))

vi.mock('../../github-api-repository', () => ({ resolveGitHubRepoExecution: mocks.resolve }))
vi.mock('../../gh-utils', () => ({
  ghExecFileAsync: mocks.exec,
  acquire: mocks.acquire,
  release: mocks.release
}))

import { updatePRBranch } from './pr-branch'

const headSha = 'a'.repeat(40)
const prRepo = { host: 'github.example.com', owner: 'upstream', repo: 'project' }
const ghOptions = { host: prRepo.host, env: { GH_HOST: prRepo.host } }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.resolve.mockResolvedValue({ ownerRepo: prRepo, ghOptions })
  mocks.exec.mockResolvedValue({ stdout: '{"message":"Updating pull request branch."}' })
})

describe('updatePRBranch', () => {
  it('updates the PR repository with the displayed head SHA and resolved host options', async () => {
    await expect(updatePRBranch('/remote/fork', 42, headSha, 'ssh-1', prRepo)).resolves.toEqual({
      ok: true
    })
    expect(mocks.resolve).toHaveBeenCalledWith('/remote/fork', prRepo, 'ssh-1', {})
    expect(mocks.exec).toHaveBeenCalledWith(
      [
        'api',
        '--method',
        'PUT',
        'repos/upstream/project/pulls/42/update-branch',
        '-f',
        `expected_head_sha=${headSha}`
      ],
      ghOptions
    )
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('preserves WSL routing options', async () => {
    await updatePRBranch('/repo', 42, headSha, null, prRepo, { wslDistro: 'Ubuntu' })
    expect(mocks.resolve).toHaveBeenCalledWith('/repo', prRepo, null, { wslDistro: 'Ubuntu' })
  })

  it('returns GitHub rejection details and releases the request slot', async () => {
    mocks.exec.mockRejectedValue(new Error('Head SHA changed (HTTP 422)'))
    await expect(updatePRBranch('/repo', 42, headSha)).resolves.toEqual({
      ok: false,
      error: 'Head SHA changed (HTTP 422)'
    })
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('does not send an update without a resolved repository', async () => {
    mocks.resolve.mockResolvedValue({ ownerRepo: null, ghOptions: {} })
    expect(await updatePRBranch('/repo', 42, headSha)).toMatchObject({ ok: false })
    expect(mocks.exec).not.toHaveBeenCalled()
  })

  it.each([
    [0, headSha],
    [42, ''],
    [42, 'not-a-sha']
  ])(
    'rejects an invalid PR number or commit before resolving the repository',
    async (prNumber, sha) => {
      expect(await updatePRBranch('/repo', Number(prNumber), String(sha))).toMatchObject({
        ok: false
      })
      expect(mocks.resolve).not.toHaveBeenCalled()
    }
  )
})
