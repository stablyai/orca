import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { glabExecFileAsyncMock } = vi.hoisted(() => ({ glabExecFileAsyncMock: vi.fn() }))

vi.mock('../../git/command-runner/glab-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  glabExecFileAsync: glabExecFileAsyncMock
}))
import {
  _getKnownHostsCacheSize,
  _resetKnownHostsCache,
  getGlabKnownHosts,
  rememberGlabKnownHost
} from './gitlab-known-host-probe'

describe('getGlabKnownHosts', () => {
  afterEach(() => vi.restoreAllMocks())

  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    _resetKnownHostsCache()
  })

  it('preserves a native auth refresh while an older native probe is in flight', async () => {
    let resolveProbe!: (value: { stdout: string; stderr: string }) => void
    glabExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveProbe = resolve
        })
    )

    const staleProbe = getGlabKnownHosts()
    rememberGlabKnownHost('gitlab.refreshed.test')
    resolveProbe({ stdout: 'Logged in to gitlab.com as user\n', stderr: '' })

    await expect(staleProbe).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
  })

  it('preserves a native auth refresh when an older native probe fails', async () => {
    let rejectProbe!: (error: Error) => void
    glabExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectProbe = reject
        })
    )

    const staleProbe = getGlabKnownHosts()
    rememberGlabKnownHost('gitlab.refreshed.test')
    rejectProbe(new Error('stale auth probe failed'))

    await expect(staleProbe).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
    await expect(getGlabKnownHosts()).resolves.toEqual(['gitlab.com', 'gitlab.refreshed.test'])
  })
})
