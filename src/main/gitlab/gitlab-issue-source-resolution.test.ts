import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  glabExecFileAsync: vi.fn()
}))

import { REMOTE_URL_PROBE_TIMEOUT_MS } from '../git/remote-url-probe'
import { _resetProjectRefCache, resolveIssueSource } from './gl-utils'

function mockGitRemotes(remotes: Record<string, string>): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args.length === 1) {
      return { stdout: `${Object.keys(remotes).join('\n')}\n` }
    }
    if (args[0] === 'remote' && args[1] === 'get-url') {
      const name = args[2]
      const url = remotes[name]
      if (url === undefined) {
        throw new Error(`error: No such remote '${name}'`)
      }
      return { stdout: `${url}\n` }
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`)
  })
}

describe('resolveIssueSource', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    _resetProjectRefCache()
  })

  it("'auto' + upstream exists → upstream, fellBack=false", async () => {
    mockGitRemotes({
      upstream: 'git@gitlab.com:stablyai/orca.git',
      origin: 'git@gitlab.com:fork/orca.git'
    })

    await expect(resolveIssueSource('/repo', 'auto')).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'stablyai/orca' },
      fellBack: false
    })
  })

  it("'auto' + no upstream → origin, fellBack=false", async () => {
    mockGitRemotes({
      upstream: 'git@example.com:stablyai/orca.git',
      origin: 'git@gitlab.com:solo/orca.git'
    })

    await expect(resolveIssueSource('/repo', 'auto')).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'solo/orca' },
      fellBack: false
    })
  })

  it("'upstream' + no upstream remote → origin, fellBack=true", async () => {
    mockGitRemotes({ origin: 'git@gitlab.com:solo/orca.git' })

    await expect(resolveIssueSource('/repo', 'upstream')).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'solo/orca' },
      fellBack: true
    })
  })

  it("'upstream' + only a non-origin GitLab remote → that remote, fellBack=true", async () => {
    mockGitRemotes({ myremote: 'git@gitlab.com:group/project.git' })

    await expect(resolveIssueSource('/repo', 'upstream')).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'group/project' },
      fellBack: true
    })
  })

  it("'upstream' does not retry the same remote during fallback enumeration", async () => {
    let upstreamProbeCount = 0
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args.length === 1) {
        return { stdout: 'upstream\n' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'upstream') {
        upstreamProbeCount += 1
        if (upstreamProbeCount === 1) {
          throw new Error('timed out')
        }
        return { stdout: 'git@gitlab.com:stablyai/orca.git\n' }
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        throw new Error("error: No such remote 'origin'")
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    await expect(resolveIssueSource('/repo', 'upstream')).resolves.toEqual({
      source: null,
      fellBack: false
    })
    expect(upstreamProbeCount).toBe(1)
  })

  it("'origin' + upstream exists → origin (ignores upstream), fellBack=false", async () => {
    mockGitRemotes({
      origin: 'git@gitlab.com:fork/orca.git',
      upstream: 'git@gitlab.com:stablyai/orca.git'
    })

    await expect(resolveIssueSource('/repo', 'origin')).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'fork/orca' },
      fellBack: false
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
    })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(
      ['remote', 'get-url', 'upstream'],
      expect.anything()
    )
  })

  it('undefined preference is treated identically to auto', async () => {
    mockGitRemotes({ upstream: 'git@gitlab.com:stablyai/orca.git' })

    await expect(resolveIssueSource('/repo', undefined)).resolves.toEqual({
      source: { host: 'gitlab.com', path: 'stablyai/orca' },
      fellBack: false
    })
  })
})
