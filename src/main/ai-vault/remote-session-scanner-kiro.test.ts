import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'
import { KIRO_FIXTURE_SESSION_ID } from './session-scanner-kiro-fixtures'

afterEach(() => vi.unstubAllEnvs())

describe('remote Kiro history', () => {
  it.each([
    ['linux-x64', '/home/ada', '/srv/kiro'],
    ['win32-x64', 'C:/Users/Ada', 'D:/kiro']
  ] as const)(
    'reads the %s execution host override, independent of the client',
    async (platform, remoteHome, kiroHomeDir) => {
      vi.stubEnv('KIRO_HOME', '/client/must-not-be-read')
      const provider = new MemoryRemoteProvider()
      const path = `${kiroHomeDir}/sessions/cli/${KIRO_FIXTURE_SESSION_ID}.json`
      provider.addFile(path, JSON.stringify({ cwd: remoteHome, title: 'Remote Kiro' }), 10)
      provider.addFile(
        `${path}l`,
        jsonLines([
          { kind: 'Prompt', data: { content: [{ kind: 'text', data: 'Read the file' }] } },
          { kind: 'AssistantMessage', data: { content: [{ kind: 'text', data: 'Done' }] } }
        ]),
        11
      )
      const result = await scanRemoteAiVaultSessions({
        provider,
        executionHostId: 'ssh:kiro-host',
        remoteHome,
        kiroHomeDir,
        hostPlatform: getRemoteHostPlatform(platform)
      })
      expect(result.issues).toEqual([])
      expect(result.sessions).toHaveLength(1)
      expect(result.sessions[0]).toMatchObject({
        agent: 'kiro',
        sessionId: KIRO_FIXTURE_SESSION_ID,
        filePath: path,
        messageCount: 2,
        executionHostId: 'ssh:kiro-host'
      })
    }
  )

  it('keeps the remote default when the peer supplies no override', async () => {
    vi.stubEnv('KIRO_HOME', '/client/must-not-be-read')
    const provider = new MemoryRemoteProvider()
    const path = `/home/ada/.kiro/sessions/cli/${KIRO_FIXTURE_SESSION_ID}.json`
    provider.addFile(path, JSON.stringify({ cwd: '/home/ada', title: 'Remote Kiro' }), 10)
    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:kiro-host',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })
    expect(result.issues).toEqual([])
    expect(result.sessions[0]?.filePath).toBe(path)
  })
})
