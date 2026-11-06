import { openCodexThread } from '../threads/codex-structured-thread-open'
import { CodexAppServerRequestError } from '../../app-server/codex-app-server-request-error'
import { agentSessionRecordFixture } from '../../../native-chat/agent-session-record-test-fixture'
import { createCodexStructuredLaunchResolver } from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

const { isWindowsProcessStartTimeAvailable } = vi.hoisted(() => ({
  isWindowsProcessStartTimeAvailable: vi.fn(() => true)
}))

vi.mock('../../../windows/windows-process-table', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isWindowsProcessStartTimeAvailable
}))

const SESSION_ID = 'session-1'
const IDENTITY = { sessionId: SESSION_ID } as Parameters<
  ReturnType<typeof createCodexStructuredLaunchResolver>
>[0]['identity']

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return agentSessionRecordFixture({
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
  })
}

function resolverFor(
  value: AgentSessionRecord | null,
  resolveWorkspacePath: (workspaceId: string) => Promise<string> = async (id) => `/repos/${id}`,
  resolveLaunchArgs?: () => string[]
) {
  return createCodexStructuredLaunchResolver({
    store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
    resolveWorkspacePath,
    resolveCommand: () => ({ command: '/usr/local/bin/codex', prefixArgs: [] }),
    resolveLaunchArgs: resolveLaunchArgs ?? (() => value?.launchArgs ?? [])
  })
}

describe('codex structured launch resolution', () => {
  it.each(['start', 'resume'] as const)(
    're-reads saved Arguments after a refusal on %s',
    async (mode) => {
      let args = ['--remote', 'wss://host']
      const resolve = resolverFor(
        record({
          launchArgs: ['--enable', 'stale'],
          providerHandleChain:
            mode === 'resume'
              ? [
                  {
                    linkId: 'link-current',
                    handle: codexProviderHandle('thread-current'),
                    origin: 'created',
                    mintedAtFence: 1,
                    observedAt: 1
                  }
                ]
              : []
        }),
        undefined,
        () => args
      )
      await expect(resolve({ identity: IDENTITY })).rejects.toThrow(/Arguments/)
      args = ['--enable', 'unified_exec']
      expect((await resolve({ identity: IDENTITY })).args).toEqual([
        '--enable',
        'unified_exec',
        'app-server'
      ])
      args = []
      expect((await resolve({ identity: IDENTITY })).args).toEqual(['app-server'])
    }
  )

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

it.each(['fork', 'resume', 'clear'] as const)(
  'keeps the side-chat identity on %s',
  async (mode) => {
    const side = record({
      sideChat: { sourceSessionId: 'codex_parent_123', sourceProviderSessionId: 'parent-thread' },
      providerHandleChain:
        mode === 'resume'
          ? [
              {
                linkId: 'child-link',
                handle: codexProviderHandle('child-thread'),
                origin: 'created',
                mintedAtFence: 1,
                observedAt: 1
              }
            ]
          : [],
      ...(mode === 'clear'
        ? { providerContextBoundary: { operationId: 'clear', afterFence: 2, clearedAt: 100 } }
        : {})
    })
    const launch = await resolverFor(side)({ identity: IDENTITY })
    expect(launch.sideChat).toBe(true)
    expect(launch.resumeThreadId).toBe(mode === 'resume' ? 'child-thread' : null)
    expect(launch.forkThreadId).toBe(mode === 'fork' ? 'parent-thread' : undefined)
    expect(launch.supersedeIfUnsaved).toBeUndefined()
  }
)

it.each(['created', 'resumed', 'adopted'] as const)(
  'recovers a cleared side chat without a rollout only for a %s handle',
  async (origin) => {
    const launch = await resolverFor(
      record({
        sideChat: { sourceSessionId: 'codex_parent_123', sourceProviderSessionId: 'parent-thread' },
        providerContextBoundary: { operationId: 'clear', afterFence: 2, clearedAt: 100 },
        providerHandleChain: [
          {
            linkId: 'cleared-child',
            handle: codexProviderHandle('cleared-thread'),
            origin,
            mintedAtFence: 3,
            observedAt: 101
          }
        ]
      })
    )({ identity: IDENTITY })
    const noRollout = new CodexAppServerRequestError(
      'thread/resume',
      -32600,
      'codex app-server thread/resume failed: no rollout found for thread id cleared-thread'
    )
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/resume') {
        throw noRollout
      }
      return { thread: { id: 'replacement-thread' } }
    })
    const opened = openCodexThread({ request }, { ...launch, cwd: '/repos/workspace-1' }, 2_000)
    if (origin === 'created') {
      await expect(opened).resolves.toMatchObject({
        threadId: 'replacement-thread',
        supersededThreadId: 'cleared-thread'
      })
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        'thread/resume',
        'thread/start'
      ])
    } else {
      await expect(opened).rejects.toMatchObject({
        reason: 'savedConversationMissing',
        cause: noRollout
      })
      expect(request).toHaveBeenCalledOnce()
    }
    expect(launch.forkThreadId).toBeUndefined()
  }
)
