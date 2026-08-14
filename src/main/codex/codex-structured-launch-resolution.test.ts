import { describe, expect, it } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { createCodexStructuredLaunchResolver } from './codex-structured-launch-resolution'

const SESSION_ID = 'session-1'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createCodexStructuredLaunchResolver>
>[0]['identity']

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    sessionId: SESSION_ID,
    provider: 'codex',
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    accountHome: { variable: 'CODEX_HOME', path: '/home/work/.codex' },
    providerHandleChain: [],
    ...overrides
  } as AgentSessionRecord
}

function resolverFor(
  value: AgentSessionRecord | null,
  resolveWorkspacePath: (workspaceId: string) => Promise<string> = async (id) => `/repos/${id}`
) {
  return createCodexStructuredLaunchResolver({
    store: { getRecord: () => value } as unknown as AgentSessionRecordStore,
    resolveWorkspacePath,
    resolveCommand: () => '/usr/local/bin/codex'
  })
}

describe('codex structured launch resolution', () => {
  it('launches the app server in the workspace and account home the record pinned', async () => {
    const launch = await resolverFor(record())({ identity: IDENTITY })

    expect(launch).toEqual({
      command: '/usr/local/bin/codex',
      args: ['app-server'],
      cwd: '/repos/workspace-1',
      codexHome: '/home/work/.codex',
      resumeThreadId: null
    })
  })

  it('resumes the last thread this session actually proved, not one a caller names', async () => {
    const launch = await resolverFor(
      record({
        providerHandleChain: [
          { handle: { provider: 'codex', threadId: 'thread-old' } },
          { handle: { provider: 'codex', threadId: 'thread-current' } }
        ] as AgentSessionRecord['providerHandleChain']
      })
    )({ identity: IDENTITY })

    expect(launch.resumeThreadId).toBe('thread-current')
  })

  it('refuses a session pinned to another host rather than starting a second writer here', async () => {
    await expect(
      resolverFor(
        record({
          location: { ...record().location, executionHostId: 'ssh:build-box' }
        } as Partial<AgentSessionRecord>)
      )({ identity: IDENTITY })
    ).rejects.toThrow(/local host/)
  })

  it('refuses a WSL session, which is a separate filesystem and process namespace', async () => {
    await expect(
      resolverFor(record({ location: { ...record().location, wslDistro: 'Ubuntu' } }))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/local host/)
  })

  it('refuses a record this adapter does not speak for', async () => {
    await expect(
      resolverFor(record({ provider: 'claude' } as Partial<AgentSessionRecord>))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/is a claude session/)
    await expect(
      resolverFor(
        record({ accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/.claude' } })
      )({
        identity: IDENTITY
      })
    ).rejects.toThrow(/CODEX_HOME/)
  })

  it('refuses to launch for a session the store has no record of', async () => {
    await expect(resolverFor(null)({ identity: IDENTITY })).rejects.toThrow(/no durable/)
  })

  it('surfaces a workspace that no longer resolves instead of falling back to a default cwd', async () => {
    await expect(
      resolverFor(record(), async () => {
        throw new Error('workspace-1 is gone')
      })({ identity: IDENTITY })
    ).rejects.toThrow('workspace-1 is gone')
  })
})
