import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GlUtils from './gl-utils'

const { gitExecFileAsyncMock, glabExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  glabExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  glabExecFileAsync: glabExecFileAsyncMock
}))

vi.mock('./gl-utils', async () => {
  const actual = await vi.importActual<typeof GlUtils>('./gl-utils')
  return {
    ...actual,
    acquire: vi.fn(async () => undefined),
    getGlabKnownHosts: vi.fn(async () => ['gitlab.com']),
    release: vi.fn()
  }
})

import { listIssues } from './issues'
import { _resetProjectRefCache, resolveIssueSource } from './gitlab-project-ref-resolution'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from '../git/remote-url-probe'

const GIT_OPTIONS = {
  cwd: '/repo',
  timeout: REMOTE_URL_PROBE_TIMEOUT_MS
}

function remoteUrlCall(remoteName: string): [string[], typeof GIT_OPTIONS] {
  return [['remote', 'get-url', remoteName], GIT_OPTIONS]
}

function mockSoleRemote(remoteName: string, remoteUrl: string): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: `${remoteName}\n`, stderr: '' }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      if (args[2] === remoteName) {
        return { stdout: `${remoteUrl}\n`, stderr: '' }
      }
      throw new Error(`error: No such remote '${args[2]}'`)
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`)
  })
}

describe('GitLab nonstandard remote contract (#13816)', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    glabExecFileAsyncMock.mockReset()
    _resetProjectRefCache()
  })

  it('resolves and lists issues through a sole myremote without repeat Git fanout', async () => {
    mockSoleRemote('myremote', 'git@gitlab.com:group/project.git')
    glabExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify([
        {
          iid: 7,
          title: 'Fixture issue',
          state: 'opened',
          web_url: 'https://gitlab.com/group/project/-/issues/7',
          labels: []
        }
      ])
    })

    await expect(resolveIssueSource('/repo', 'auto', ['gitlab.com'])).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'group/project' },
      fellBack: false
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      remoteUrlCall('upstream'),
      remoteUrlCall('origin'),
      [['remote'], GIT_OPTIONS],
      remoteUrlCall('myremote')
    ])

    gitExecFileAsyncMock.mockClear()
    await expect(listIssues('/repo', 20)).resolves.toMatchObject({
      items: [{ number: 7, title: 'Fixture issue' }]
    })
    await expect(listIssues('/repo', 20)).resolves.toMatchObject({
      items: [{ number: 7, title: 'Fixture issue' }]
    })

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(glabExecFileAsyncMock.mock.calls).toEqual([
      [
        [
          'api',
          'projects/group%2Fproject/issues?per_page=20&order_by=updated_at&sort=desc&state=opened'
        ],
        { cwd: '/repo' }
      ],
      [
        [
          'api',
          'projects/group%2Fproject/issues?per_page=20&order_by=updated_at&sort=desc&state=opened'
        ],
        { cwd: '/repo' }
      ]
    ])
  })

  it('keeps upstream then origin precedence without enumerating remotes', async () => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[2] === 'upstream') {
        return { stdout: 'git@gitlab.com:canonical/project.git\n', stderr: '' }
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    await expect(resolveIssueSource('/repo', 'auto', ['gitlab.com'])).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'canonical/project' },
      fellBack: false
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([remoteUrlCall('upstream')])
  })

  it('does not reinterpret explicit origin as an arbitrary sole remote', async () => {
    mockSoleRemote('myremote', 'git@gitlab.com:group/project.git')

    await expect(resolveIssueSource('/repo', 'origin', ['gitlab.com'])).resolves.toEqual({
      source: null,
      fellBack: false
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([remoteUrlCall('origin')])
    expect(glabExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
