import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider } from './remote-session-scanner-test-fixtures'
import { resetRemoteSessionParseCacheForTests } from './remote-session-parse-cache'

describe('remote sidecar observations', () => {
  const sessionId = '1786466194549_sidecar'
  const sessionDir = `/home/ada/.cline/data/sessions/${sessionId}`
  const messagesPath = `${sessionDir}/${sessionId}.messages.json`

  function addCline(provider: MemoryRemoteProvider, firstPrompt: string): void {
    provider.addFile(
      `${sessionDir}/${sessionId}.json`,
      JSON.stringify({
        version: 1,
        session_id: sessionId,
        started_at: '2026-08-11T16:36:34.551Z',
        cwd: '/home/ada/repo'
      }),
      10
    )
    provider.addFile(
      messagesPath,
      JSON.stringify({
        version: 1,
        updated_at: '2026-08-11T16:38:00.000Z',
        sessionId,
        messages: [{ role: 'user', content: [{ type: 'text', text: firstPrompt }] }]
      }),
      11
    )
  }

  const scan = (provider: MemoryRemoteProvider): ReturnType<typeof scanRemoteAiVaultSessions> =>
    scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

  it('re-parses when a messages-file stat fails rather than serving the cached row', async () => {
    resetRemoteSessionParseCacheForTests()
    const provider = new MemoryRemoteProvider()
    addCline(provider, 'first prompt')
    expect((await scan(provider)).sessions[0]).toMatchObject({ title: 'first prompt' })

    // The sidecar changed underneath, and its stat now fails for a reason that
    // is not "missing": nothing about it may be assumed, so the row is re-read.
    addCline(provider, 'second prompt')
    provider.failStat(
      messagesPath,
      Object.assign(new Error('permission denied'), { code: 'EACCES' })
    )

    const refused = await scan(provider)

    expect(refused.sessions[0]).toMatchObject({ title: 'second prompt' })
    expect(refused.issues.map((issue) => issue.path)).toContain(messagesPath)
  })

  it('treats a genuinely missing messages file as no sidecar, not as unknown', async () => {
    resetRemoteSessionParseCacheForTests()
    const provider = new MemoryRemoteProvider()
    provider.addFile(
      `${sessionDir}/${sessionId}.json`,
      JSON.stringify({
        version: 1,
        session_id: sessionId,
        started_at: '2026-08-11T16:36:34.551Z',
        cwd: '/home/ada/repo'
      }),
      10
    )

    const first = await scan(provider)
    const second = await scan(provider)

    expect(first.issues).toEqual([])
    expect(second.issues).toEqual([])
    expect(second.sessions[0]?.sessionId).toBe(sessionId)
  })
})
