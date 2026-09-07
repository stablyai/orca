import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { createCodexStructuredLaunchResolver } from './codex-structured-launch-resolution'

const SESSION_ID = 'session-1'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createCodexStructuredLaunchResolver>
>[0]['identity']

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

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
  resolveWorkspacePath: (workspaceId: string) => Promise<string> = async (id) => `/repos/${id}`,
  resolveRollout: () => Promise<string | null> = async () => null
) {
  return createCodexStructuredLaunchResolver({
    store: { getRecord: () => value } as unknown as AgentSessionRecordStore,
    resolveWorkspacePath,
    resolveCommand: () => '/usr/local/bin/codex',
    resolveRollout
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

  it('passes a Windows .cmd path containing cmd syntax directly to the safe spawn layer', async () => {
    const command = String.raw`C:\Users\r&d\npm-prefix\codex.cmd`

    await withPlatform('win32', async () => {
      const resolveLaunch = createCodexStructuredLaunchResolver({
        store: { getRecord: () => record() } as unknown as AgentSessionRecordStore,
        resolveWorkspacePath: async () => String.raw`C:\workspaces\orca`,
        resolveCommand: () => command
      })

      await expect(resolveLaunch({ identity: IDENTITY })).resolves.toMatchObject({
        command,
        args: ['app-server']
      })
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

  it('places the durable user configuration before the app-server subcommand', async () => {
    const launch = await resolverFor(
      record({ launchArgs: ['--profile', 'review', '-c', 'model_reasoning_effort=high'] })
    )({ identity: IDENTITY })

    expect(launch.args).toEqual([
      '--profile',
      'review',
      '-c',
      'model_reasoning_effort=high',
      'app-server'
    ])
  })

  it('pins resume to the rollout file that proved the durable thread', async () => {
    const resolveRollout = vi.fn(async () => '/home/work/.codex/sessions/rollout.jsonl')
    const launch = await resolverFor(
      record({
        providerHandleChain: [
          { handle: { provider: 'codex', threadId: 'thread-current' } }
        ] as AgentSessionRecord['providerHandleChain']
      }),
      async (id) => `/repos/${id}`,
      resolveRollout
    )({ identity: IDENTITY })

    expect(resolveRollout).toHaveBeenCalledWith('/home/work/.codex', 'thread-current')
    expect(launch.resumePath).toBe('/home/work/.codex/sessions/rollout.jsonl')
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
