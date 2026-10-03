import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execMock, hostsMock, resolveMock, acquireMock, releaseMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  hostsMock: vi.fn(),
  resolveMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gl-utils', () => ({
  glabExecFileAsync: execMock,
  getGlabKnownHosts: hostsMock,
  resolveIssueSource: resolveMock,
  acquire: acquireMock,
  release: releaseMock,
  glabHostnameArgs: (source: { host: string }) => ['--hostname', source.host],
  glabRepoExecOptions: (repoPath: string) => ({ cwd: repoPath })
}))

import { listLabels } from './project-label-and-member-lookup'

describe('GitLab project labels', () => {
  beforeEach(() => {
    execMock.mockReset()
    hostsMock.mockReset()
    resolveMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    hostsMock.mockResolvedValue(['gitlab.com'])
    resolveMock.mockResolvedValue({ source: { host: 'gitlab.com', path: 'group/project' } })
  })

  it('reads every label from paginated glab NDJSON without using unsupported --jq', async () => {
    execMock.mockResolvedValue({
      stdout: '[{"name":"bug"},{"name":"frontend"}]\n[{"name":"security"}]\n'
    })

    await expect(listLabels('/repo')).resolves.toEqual(['bug', 'frontend', 'security'])
    expect(execMock).toHaveBeenCalledWith(
      [
        'api',
        '--hostname',
        'gitlab.com',
        '--paginate',
        '--output',
        'ndjson',
        'projects/group%2Fproject/labels?per_page=100'
      ],
      { cwd: '/repo' }
    )
    expect(execMock.mock.calls[0][0]).not.toContain('--jq')
  })

  it('rejects malformed output instead of reporting an incomplete label list', async () => {
    execMock.mockResolvedValue({ stdout: '{"name":"bug"}\nnot-json\n' })
    await expect(listLabels('/repo')).rejects.toThrow('Invalid GitLab label response')
  })

  it('reports a failed label request instead of presenting it as a project with no labels', async () => {
    execMock.mockRejectedValue(new Error('glab api failed'))
    await expect(listLabels('/repo')).rejects.toThrow('glab api failed')
  })
})
