import { afterEach, describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'
import {
  KIRO_FIXTURE_SESSION_ID,
  KIRO_V3_FIXTURE_MANIFEST,
  KIRO_V3_FIXTURE_MESSAGES,
  KIRO_V3_FIXTURE_SESSION_ID
} from './session-scanner-kiro-fixtures'

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

describe('remote Kiro V3 history', () => {
  function addV3Session(provider: MemoryRemoteProvider, sessionsDir: string, sessionId: string) {
    const sessionDir = `${sessionsDir}/5fab923ac92fb45c/${sessionId}`
    provider.addFile(
      `${sessionDir}/session.json`,
      JSON.stringify({ ...KIRO_V3_FIXTURE_MANIFEST, id: sessionId }),
      20
    )
    provider.addFile(`${sessionDir}/messages.jsonl`, jsonLines(KIRO_V3_FIXTURE_MESSAGES), 21)
    return `${sessionDir}/session.json`
  }

  it.each([
    ['linux-x64', '/home/ada'],
    ['win32-x64', 'C:/Users/Ada']
  ] as const)('reads %s home .kiro/sessions beside the cli store', async (platform, remoteHome) => {
    const provider = new MemoryRemoteProvider()
    const sessionsDir = `${remoteHome}/.kiro/sessions`
    const manifestPath = addV3Session(provider, sessionsDir, KIRO_V3_FIXTURE_SESSION_ID)
    provider.addFile(`${sessionsDir}/5fab923ac92fb45c/.index/.lock`, '', 1)
    provider.addFile(
      `${sessionsDir}/cli/${KIRO_FIXTURE_SESSION_ID}.json`,
      JSON.stringify({ cwd: remoteHome, title: 'Remote Kiro' }),
      10
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:kiro-host',
      remoteHome,
      hostPlatform: getRemoteHostPlatform(platform)
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual(
      [KIRO_FIXTURE_SESSION_ID, KIRO_V3_FIXTURE_SESSION_ID].sort()
    )
    expect(
      result.sessions.find((session) => session.sessionId === KIRO_V3_FIXTURE_SESSION_ID)
    ).toMatchObject({
      agent: 'kiro',
      filePath: manifestPath,
      messageCount: 2,
      executionHostId: 'ssh:kiro-host'
    })
    // The V3 walk leaves cli/ to its own source and never enters .index.
    expect(provider.readDirPaths.filter((path) => path === `${sessionsDir}/cli`)).toHaveLength(1)
    expect(provider.readDirPaths.some((path) => path.endsWith('/.index'))).toBe(false)
  })

  it('stays under the home .kiro when the execution host overrides KIRO_HOME', async () => {
    const provider = new MemoryRemoteProvider()
    addV3Session(provider, '/home/ada/.kiro/sessions', KIRO_V3_FIXTURE_SESSION_ID)
    addV3Session(provider, '/srv/kiro/sessions', 'sess_00000000-0000-4000-8000-000000000000')

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:kiro-host',
      remoteHome: '/home/ada',
      kiroHomeDir: '/srv/kiro',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      KIRO_V3_FIXTURE_SESSION_ID
    ])
  })
})
