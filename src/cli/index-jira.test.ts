import { describe, expect, it, vi } from 'vitest'

const {
  callMock,
  runtimeClientConstructorMock,
  serveOrcaAppMock,
  getDefaultUserDataPathMock,
  addEnvironmentFromPairingCodeMock,
  listEnvironmentsMock,
  spawnMock
} = vi.hoisted(() => ({
  callMock: vi.fn(),
  runtimeClientConstructorMock: vi.fn(),
  serveOrcaAppMock: vi.fn(),
  getDefaultUserDataPathMock: vi.fn(() => '/tmp/orca-user-data'),
  addEnvironmentFromPairingCodeMock: vi.fn(),
  listEnvironmentsMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('./runtime-client', async () => {
  const { createRuntimeClientModuleMock } = await import('./index-test-harness.js')
  return createRuntimeClientModuleMock({
    callMock,
    runtimeClientConstructorMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock
  })
})

vi.mock('./runtime/environments', () => ({
  addEnvironmentFromPairingCode: addEnvironmentFromPairingCodeMock,
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('child_process', async () => {
  const { createChildProcessModuleMock } = await import('./index-test-harness.js')
  return createChildProcessModuleMock(spawnMock)
})

import { main } from './index'
import { okFixture, queueFixtures } from './test-fixtures'
import { useWorktreeAwarenessEnvironment } from './index-test-harness'

describe('Jira CLI', () => {
  useWorktreeAwarenessEnvironment({
    callMock,
    serveOrcaAppMock,
    getDefaultUserDataPathMock,
    addEnvironmentFromPairingCodeMock,
    listEnvironmentsMock,
    spawnMock
  })

  const site = { id: 'site-1', siteUrl: 'https://example.atlassian.net' }
  const status = { connected: true, sites: [site] }

  it('reads the URL-matched site through the selected remote runtime', async () => {
    queueFixtures(
      callMock,
      okFixture('status', status),
      okFixture('issue', {
        key: 'ENG-123',
        title: 'Auth',
        url: 'https://example.atlassian.net/browse/ENG-123'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(
      [
        'jira',
        'issue',
        'https://example.atlassian.net/browse/ENG-123',
        '--pairing-code',
        'remote-runtime',
        '--json'
      ],
      '/tmp'
    )
    expect(runtimeClientConstructorMock).toHaveBeenCalledWith('remote-runtime', undefined)
    expect(callMock).toHaveBeenLastCalledWith('jira.getIssue', { key: 'ENG-123', siteId: 'site-1' })
  })

  it('rejects a URL from a different site before reading the issue', async () => {
    queueFixtures(callMock, okFixture('status', status))
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['jira', 'issue', 'https://other.atlassian.net/browse/ENG-123', '--json'], '/tmp')
    expect(process.exitCode).toBe(1)
    expect(output.mock.calls.flat().join('')).toContain('No matching connected Jira site')
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('refuses ambiguous bare keys instead of using another site', async () => {
    queueFixtures(
      callMock,
      okFixture('status', { ...status, sites: [site, { ...site, id: 'site-2' }] })
    )
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['jira', 'issue', 'ENG-123', '--json'], '/tmp')
    expect(process.exitCode).toBe(1)
    expect(output.mock.calls.flat().join('')).toContain('Multiple Jira sites match')
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('reads comments with an explicit site', async () => {
    queueFixtures(
      callMock,
      okFixture('status', status),
      okFixture('comments', [{ id: 'comment-1', body: 'Review this', createdAt: '2026-10-07' }])
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['jira', 'comments', 'eng-123', '--site', 'site-1', '--json'], '/tmp')
    expect(callMock).toHaveBeenLastCalledWith('jira.issueComments', {
      key: 'ENG-123',
      siteId: 'site-1'
    })
  })

  it('reports an unavailable issue as a failure', async () => {
    queueFixtures(callMock, okFixture('status', status), okFixture('issue', null))
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['jira', 'issue', 'ENG-123', '--json'], '/tmp')
    expect(process.exitCode).toBe(1)
    expect(output.mock.calls.flat().join('')).toContain('Jira issue was not returned')
  })

  it('does not call the runtime for an invalid URL', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['jira', 'issue', 'https://example.atlassian.net', '--json'], '/tmp')
    expect(process.exitCode).toBe(1)
    expect(output.mock.calls.flat().join('')).toContain('Expected a Jira issue key')
    expect(callMock).not.toHaveBeenCalled()
  })
  it('does not block a healthy site because another site has a credential error', async () => {
    queueFixtures(
      callMock,
      okFixture('status', { ...status, credentialError: 'Other site cannot decrypt' }),
      okFixture('issue', {
        key: 'ENG-123',
        title: 'Auth',
        url: 'https://example.atlassian.net/browse/ENG-123'
      })
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['jira', 'issue', 'ENG-123', '--site', 'site-1', '--json'], '/tmp')
    expect(callMock).toHaveBeenLastCalledWith('jira.getIssue', { key: 'ENG-123', siteId: 'site-1' })
  })
  it('does not report an empty legacy comment response as verified absence', async () => {
    queueFixtures(callMock, okFixture('status', status), okFixture('comments', []))
    const output = vi.spyOn(console, 'log').mockImplementation(() => {})
    await main(['jira', 'comments', 'ENG-123', '--json'], '/tmp')
    expect(process.exitCode).toBe(1)
    expect(output.mock.calls.flat().join('')).toContain('jira_comments_unverified')
  })
})
