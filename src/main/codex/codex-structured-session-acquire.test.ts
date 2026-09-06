import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { runProcess } from '../../shared/child-process/run-process'
import type { openCodexAppServerConnection } from './codex-app-server-connection'
import {
  CodexStructuredSessionAdapter,
  type CodexStructuredLaunch
} from './codex-structured-session-adapter'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'

vi.mock('../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))

const REFERENCE = 'doppler-ref://lets-tango/dev_ops/POSTHOG_READ_ONLY'
const SENTINEL = 'sentinel-plaintext-secret'
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

function createOpenConnection(capture: (env: Record<string, string> | undefined) => void) {
  return (async (launch) => {
    capture(launch.env)
    return {
      pid: 4321,
      closed: false,
      request: async (method: string) =>
        method === 'thread/start'
          ? { thread: { id: 'thread-1', path: '/rollouts/thread-1.jsonl' } }
          : {},
      notify: () => {},
      respond: () => {},
      respondWithError: () => {},
      close: async () => true
    }
  }) as typeof openCodexAppServerConnection
}

describe('structured Codex secret references', () => {
  beforeEach(() => {
    vi.mocked(runProcess).mockReset()
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stdout: `${SENTINEL}\n`,
      stderr: '',
      timedOut: false,
      outputTruncated: false
    })
  })

  it('passes plaintext only to the child environment and keeps the launch record unchanged', async () => {
    const durableLaunch: CodexStructuredLaunch = {
      command: 'codex',
      args: ['app-server'],
      cwd: '/work/repo',
      codexHome: '/pinned/codex-home',
      resumeThreadId: null,
      env: { POSTHOG_READ_ONLY: REFERENCE, CODEX_HOME: '/shell/codex-home' }
    }
    let childEnv: Record<string, string> | undefined
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => durableLaunch,
      openConnection: createOpenConnection((env) => {
        childEnv = env
      }),
      readProcessStartTime: async () => 1_700_000_000_000
    })

    await adapter.acquire({ identity: IDENTITY, fence: 7, spawnToken: 'spawn-token' })

    expect(childEnv).toEqual({
      POSTHOG_READ_ONLY: SENTINEL,
      CODEX_HOME: '/pinned/codex-home',
      [CODEX_SPAWN_TOKEN_ENV]: 'spawn-token'
    })
    expect(durableLaunch.env).toEqual({
      POSTHOG_READ_ONLY: REFERENCE,
      CODEX_HOME: '/shell/codex-home'
    })
  })

  it('aborts before provider spawn without exposing failed process output', async () => {
    vi.mocked(runProcess).mockResolvedValue({
      code: 1,
      signal: null,
      stdout: SENTINEL,
      stderr: '',
      timedOut: false
    })
    const openConnection = vi.fn(createOpenConnection(() => {}))
    const adapter = new CodexStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'codex',
        args: ['app-server'],
        cwd: '/work/repo',
        codexHome: '/pinned/codex-home',
        resumeThreadId: null,
        env: { POSTHOG_READ_ONLY: REFERENCE }
      }),
      openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })

    const rejection = adapter.acquire({ identity: IDENTITY, fence: 7, spawnToken: 'spawn-token' })

    await expect(rejection).rejects.toThrow('nonzero-exit')
    await expect(rejection).rejects.not.toThrow(SENTINEL)
    expect(openConnection).not.toHaveBeenCalled()
  })
})
