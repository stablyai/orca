import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform, joinRemotePath } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'

function messageGraphTranscript(sessionId: string, title: string): string {
  return jsonLines([
    {
      type: 'session',
      id: sessionId,
      timestamp: '2026-07-04T04:00:00.000Z',
      cwd: '/home/ada/repo'
    },
    {
      type: 'message',
      timestamp: '2026-07-04T04:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: title }] }
    }
  ])
}

describe('remote OpenClaw discovery', () => {
  it.each([
    ['linux-x64', '/home/ada'],
    ['darwin-arm64', '/Users/ada'],
    ['win32-x64', 'C:\\Users\\Ada']
  ] as const)('keeps canonical and nested sessions on %s', async (platform, remoteHome) => {
    const hostPlatform = getRemoteHostPlatform(platform)
    const provider = new MemoryRemoteProvider()
    const expectedIds: string[] = []
    const expectedPaths: string[] = []
    for (const rootName of ['.openclaw', '.clawdbot']) {
      const root = joinRemotePath(hostPlatform, remoteHome, rootName, 'agents')
      expectedPaths.push(root)
      for (const agent of ['main', 'review agent']) {
        const agentRoot = joinRemotePath(hostPlatform, root, agent)
        const sessions = joinRemotePath(hostPlatform, agentRoot, 'sessions')
        const nested = joinRemotePath(hostPlatform, sessions, '2026-07')
        expectedPaths.push(agentRoot, sessions, nested)
        for (const [directory, suffix] of [
          [sessions, 'direct'],
          [nested, 'nested']
        ]) {
          const sessionId = `${rootName}-${agent}-${suffix}`
          expectedIds.push(sessionId)
          provider.addFile(
            joinRemotePath(hostPlatform, directory, `${suffix}.jsonl`),
            messageGraphTranscript(sessionId, sessionId),
            40
          )
        }
        provider.addFile(
          joinRemotePath(
            hostPlatform,
            agentRoot,
            'agent',
            'codex-home',
            'sessions',
            'nested.jsonl'
          ),
          messageGraphTranscript('nested-runtime-session', 'Nested Codex home'),
          41
        )
      }
    }

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome,
      hostPlatform
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId).sort()).toEqual(expectedIds.sort())
    expect(result.sessions.every((session) => session.executionHostId === 'ssh:dev-box')).toBe(true)
    expect(
      provider.readDirPaths
        .filter((path) => /\/(?:\.openclaw|\.clawdbot)\/agents(?:\/|$)/.test(path))
        .sort()
    ).toEqual(expectedPaths.sort())
  })

  it('keeps discovery work independent of sibling cache size', async () => {
    const provider = new MemoryRemoteProvider()
    const root = '/home/ada/.openclaw/agents'
    provider.addFile(
      `${root}/main/sessions/session.jsonl`,
      messageGraphTranscript('canonical', 'Canonical session'),
      40
    )
    for (let index = 0; index < 512; index += 1) {
      provider.addFile(`${root}/main/cache/entry-${index}/nested/sessions/state.jsonl`, '{}', 1)
    }

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    const visited = provider.readDirPaths.filter((path) => path.startsWith(root))
    expect(visited).toHaveLength(3)
    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual(['canonical'])
    expect(visited).toEqual([root, `${root}/main`, `${root}/main/sessions`])
  })

  it('reports a pruned agent directory that holds transcripts outside sessions/', async () => {
    const provider = new MemoryRemoteProvider()
    const root = '/home/ada/.clawdbot/agents'
    provider.addFile(
      `${root}/main/sessions/session.jsonl`,
      messageGraphTranscript('canonical', 'Canonical session'),
      40
    )
    provider.addFile(
      `${root}/relocated/archive/sessions/old.jsonl`,
      messageGraphTranscript('old', 'Relocated archive'),
      41
    )
    // A fresh agent carries only its runtime dir; that is not a pruned archive.
    provider.addFile(`${root}/fresh/agent/models.json`, '{}', 1)

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.sessions.map((session) => session.sessionId)).toEqual(['canonical'])
    expect(result.issues).toEqual([
      expect.objectContaining({
        agent: 'openclaw',
        executionHostId: 'ssh:dev-box',
        kind: 'notice',
        path: `${root}/relocated`
      })
    ])
  })

  it('reports an unreadable canonical directory while retaining another agent', async () => {
    const provider = new MemoryRemoteProvider()
    const root = '/home/ada/.openclaw/agents'
    for (const agent of ['unreadable', 'healthy']) {
      provider.addFile(
        `${root}/${agent}/sessions/session.jsonl`,
        messageGraphTranscript(agent, agent),
        40
      )
    }
    provider.failReadDir(`${root}/unreadable/sessions`, new Error('EACCES: permission denied'))

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64')
    })

    expect(result.sessions.map((session) => session.sessionId)).toEqual(['healthy'])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]).toMatchObject({
      agent: 'openclaw',
      executionHostId: 'ssh:dev-box',
      path: `${root}/unreadable/sessions`
    })
  })
})
