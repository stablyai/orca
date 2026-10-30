import { beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { CodexAppServerConnection } from './app-server/codex-app-server-connection-types'
import type { CodexStructuredSessionAdapterDeps } from './codex-structured-session-state'
import { materializeCodexConversationFork } from './codex-conversation-fork'

const support = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('./codex-fork-cut-support', () => ({ requireCodexForkCutSupport: support }))

function fixture() {
  const record = agentSessionRecordFixture({
    sessionId: 'parent-chat',
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/parent-account' },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    },
    permissionMode: 'full-access',
    options: { model: 'parent-choice', effort: 'high' },
    launchArgs: ['--disable', 'fast_mode'],
    providerHandleChain: [
      {
        linkId: 'parent-link',
        handle: codexProviderHandle('parent-thread'),
        origin: 'adopted',
        mintedAtFence: 1,
        observedAt: 1
      }
    ]
  })
  const request = vi.fn<CodexAppServerConnection['request']>(async (method) => {
    if (method === 'thread/read') {
      return { thread: { id: 'parent-thread', model: 'parent-native', reasoningEffort: 'low' } }
    }
    if (method === 'thread/fork') {
      return { thread: { id: 'child-thread' }, model: 'host-allowed', reasoningEffort: 'high' }
    }
    return {
      data: [
        {
          id: 'B',
          status: 'completed',
          itemsView: 'full',
          items: [{ type: 'agentMessage', id: 'reply', text: 'B' }]
        }
      ],
      nextCursor: null
    }
  })
  const close = vi.fn(async () => true)
  const connection: CodexAppServerConnection = {
    pid: undefined,
    closed: false,
    request,
    close,
    notify: () => {},
    respond: () => {},
    respondWithError: () => {}
  }
  const readLaunch = vi.fn(async () => ({
    command: 'codex',
    args: ['--model', 'global-latest', 'app-server'],
    cwd: '/parent-directory',
    codexHome: '/parent-account',
    resumeThreadId: 'parent-thread',
    env: { CODEX_HOME: '/parent-account' },
    envToDelete: []
  }))
  const openConnection = vi.fn(async () => connection)
  const deps: CodexStructuredSessionAdapterDeps = {
    resolveLaunch: async () => {
      throw new Error('must not reserve a child spawn')
    },
    readLaunch,
    openConnection
  }
  const beforeFork = vi.fn(async () => {})
  return { record, deps, request, close, readLaunch, openConnection, beforeFork }
}

beforeEach(() => support.mockReset())

describe('at-rest Codex conversation fork', () => {
  it('uses parent launch, choices and permissions for a folder workspace, then closes its temporary connection', async () => {
    const f = fixture()
    const original = structuredClone(f.record)
    const result = await materializeCodexConversationFork(f.deps, {
      record: f.record,
      sessionId: 'child-chat',
      lastTurnId: 'B',
      beforeFork: f.beforeFork
    })
    expect(f.readLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'parent-chat',
        workspaceId: 'folder-1',
        providerHandle: codexProviderHandle('parent-thread')
      })
    )
    expect(f.openConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['--disable', 'fast_mode', 'app-server'],
        cwd: '/parent-directory',
        env: { CODEX_HOME: '/parent-account' }
      })
    )
    expect(f.request).toHaveBeenCalledWith(
      'thread/fork',
      expect.objectContaining({
        model: 'parent-choice',
        config: { model_reasoning_effort: 'high' },
        approvalPolicy: 'never',
        sandbox: 'danger-full-access'
      }),
      expect.anything()
    )
    expect(result.options).toMatchObject({ model: 'host-allowed', effort: 'high' })
    expect(result.providerHandle).toEqual(codexProviderHandle('child-thread'))
    expect(f.record).toEqual(original)
    expect(f.beforeFork).toHaveBeenCalledOnce()
    expect(f.close).toHaveBeenCalledOnce()
  })

  it('never claims an operation or forks when the installed server cannot enforce the cut', async () => {
    const f = fixture()
    support.mockRejectedValueOnce(new Error('unsupported cut'))
    await expect(
      materializeCodexConversationFork(f.deps, {
        record: f.record,
        sessionId: 'child-chat',
        lastTurnId: 'B',
        beforeFork: f.beforeFork
      })
    ).rejects.toThrow('unsupported cut')
    expect(f.beforeFork).not.toHaveBeenCalled()
    expect(f.openConnection).not.toHaveBeenCalled()
  })

  it('does not declare readiness when its temporary provider cannot close', async () => {
    const f = fixture()
    f.close.mockResolvedValueOnce(false)
    await expect(
      materializeCodexConversationFork(f.deps, {
        record: f.record,
        sessionId: 'child-chat',
        lastTurnId: 'B',
        beforeFork: f.beforeFork
      })
    ).rejects.toThrow('outcome is unknown')
    expect(f.beforeFork).toHaveBeenCalledOnce()
  })

  it('closes after a post-claim error without retrying the native mutation', async () => {
    const f = fixture()
    f.request.mockImplementation(async (method) => {
      if (method === 'thread/read') {
        return { thread: { id: 'parent-thread' } }
      }
      throw new Error('lost fork reply')
    })
    await expect(
      materializeCodexConversationFork(f.deps, {
        record: f.record,
        sessionId: 'child-chat',
        lastTurnId: 'B',
        beforeFork: f.beforeFork
      })
    ).rejects.toThrow('lost fork reply')
    expect(f.beforeFork).toHaveBeenCalledOnce()
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.close).toHaveBeenCalledOnce()
  })
})
