import type { MobileHistoryResumeResult } from './mobile-history-session-continuation'
import { historyClient, historySession } from './mobile-history-test-fixture'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../src/shared/ai-vault/contracts/ai-vault-types'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { stubRpcClient } from '../transport/rpc/rpc-client-test-stub'
import { useMobileHistorySessionResume } from './use-mobile-history-session-resume'

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }))

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  back: vi.fn(),
  shellOpen: vi.fn(),
  shellReturns: true
}))
vi.mock('../navigation/route-handoff', () => ({
  useShellSessionHandoff: () => ({
    returns: () => navigation.shellReturns,
    open: navigation.shellOpen
  })
}))
vi.mock('../navigation/workspace-execution-host', () => ({
  useWorkspaceExecutionHost: () => undefined,
  workspaceRouteHref: (href: string) => href
}))
vi.mock('../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => navigation
}))
vi.mock('../session/session-screen-handlers', () => ({ useSessionScreenHandlers: () => undefined }))
vi.mock('../components/feedback/TransientToast', () => ({
  useTransientToast: () => ({ message: null, showToast: () => {} })
}))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))

const LEAF = '11111111-1111-4111-8111-111111111111'

function session(agent: 'codex' | 'claude'): AiVaultSession {
  return {
    id: `${agent}:provider`,
    executionHostId: 'local',
    agent,
    sessionId: 'provider',
    title: 'Current work',
    cwd: '/repo',
    filePath: `/sessions/${agent}.jsonl`,
    codexHome: null,
    branch: null,
    model: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-11-19T00:00:00Z',
    messageCount: 2,
    totalTokens: 0,
    previewMessages: [{ role: 'assistant', text: 'Old context', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null,
    structuredSession: { sessionId: 'old-owner', workspaceId: 'old-workspace' }
  }
}

function success(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result }
}

async function withResume(
  client: RpcClient,
  run: (
    resume: ReturnType<typeof useMobileHistorySessionResume>['onResumeSession'],
    current: () => ReturnType<typeof useMobileHistorySessionResume>
  ) => Promise<unknown>
) {
  const probe: { value?: ReturnType<typeof useMobileHistorySessionResume> } = {}
  function Probe() {
    probe.value = useMobileHistorySessionResume({
      hostId: 'host',
      worktreeId: 'route',
      origin: 'session',
      client,
      connState: 'connected',
      worktrees: []
    })
    return null
  }
  const mounted: { tree?: ReactTestRenderer } = {}
  await act(() => {
    mounted.tree = create(createElement(Probe))
  })
  try {
    if (!probe.value) {
      throw new Error('missing probe')
    }
    const current = () => {
      if (!probe.value) {
        throw new Error('missing probe')
      }
      return probe.value
    }
    const resume: ReturnType<typeof useMobileHistorySessionResume>['onResumeSession'] = async (
      ...args
    ) => {
      let result: MobileHistoryResumeResult = undefined
      await act(async () => {
        result = await current().onResumeSession(...args)
      })
      return result
    }
    await run(resume, current)
  } finally {
    await act(() => mounted.tree?.unmount())
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  navigation.shellReturns = true
})

describe('continuing mobile history from the current host record', () => {
  it.each(['codex', 'claude'] as const)(
    'opens the latest %s owner instead of the owner cached by history',
    async (agent) => {
      const selected = session(agent)
      const client = stubRpcClient({
        sendRequest: async (method, params) => {
          if (method === 'aiVault.listSessions') {
            expect(params).toMatchObject({ force: true, scopePaths: ['/repo'] })
            return success({
              sessions: [
                {
                  ...selected,
                  structuredSession: { sessionId: 'new-owner', workspaceId: 'new-workspace' }
                }
              ],
              issues: []
            })
          }
          if (method === 'session.tabs.list') {
            expect(params).toEqual({ worktree: 'id:new-workspace' })
            return success({
              tabs: [{ type: 'agent-session', id: 'chat-tab', sessionId: 'new-owner', agent }]
            })
          }
          if (method === 'session.tabs.activate') {
            return success({})
          }
          throw new Error(`unexpected request: ${method}`)
        }
      })
      await withResume(client, (resume) => resume(selected))
      expect(navigation.replace).toHaveBeenCalledWith(
        '/h/host/session/new-workspace?paneKey=chat-tab%3A44f1beb3-983a-4e95-a3c1-e499c925a0f8'
      )
    }
  )

  it('forks the refreshed chat and opens its returned terminal pane', async () => {
    const selected = session('codex')
    const client = stubRpcClient({
      sendRequest: async (method, params) => {
        if (method === 'aiVault.listSessions') {
          return success({
            sessions: [
              {
                ...selected,
                structuredSession: { sessionId: 'new-owner', workspaceId: 'new-workspace' }
              }
            ],
            issues: []
          })
        }
        if (method === 'status.get') {
          return success({ capabilities: ['session.tabs.chat-fork-cli.v1'] })
        }
        if (method === 'session.tabs.createTerminal') {
          expect(params).toMatchObject({
            worktree: 'id:new-workspace',
            sourceChatFork: { sessionId: 'new-owner' },
            activate: false,
            navigation: 'caller'
          })
          return success({
            tab: {
              type: 'terminal',
              id: 'terminal-tab',
              parentTabId: 'group',
              leafId: LEAF,
              terminal: 'pty'
            }
          })
        }
        throw new Error(`unexpected request: ${method}`)
      }
    })
    await withResume(client, (resume) => resume(selected, { kind: 'cli' }))
    expect(navigation.replace).toHaveBeenCalledWith(
      '/h/host/session/new-workspace?paneKey=group%3A11111111-1111-4111-8111-111111111111'
    )
  })

  it.each([true, false])(
    'uses the shell return support (%s) when the session handler is in another document',
    async (returns) => {
      navigation.shellReturns = returns
      const selected = { ...session('claude'), structuredSession: undefined }
      const client = stubRpcClient({
        sendRequest: async (method) => {
          const results: Record<string, unknown> = {
            'aiVault.listSessions': { sessions: [selected], issues: [] },
            'status.get': {
              hostPlatform: 'darwin',
              capabilities: ['session.tabs.owned-startup.v1']
            },
            'repo.list': { repos: [{ id: 'repo', path: '/repo' }] },
            'folderWorkspace.list': { folderWorkspaces: [] },
            'projectGroup.list': { groups: [] },
            'settings.get': {},
            'worktree.ps': { worktrees: [{ worktreeId: 'route', repoId: 'repo', path: '/repo' }] },
            'session.tabs.createTerminal': {
              tab: {
                type: 'terminal',
                id: 'new-tab',
                terminal: 'pty',
                parentTabId: 'group',
                leafId: LEAF
              }
            },
            'terminal.send': {}
          }
          if (!(method in results)) {
            throw new Error(`unexpected request: ${method}`)
          }
          return success(results[method])
        }
      })
      await withResume(client, (resume) => resume(selected))
      if (returns) {
        expect(navigation.shellOpen).toHaveBeenCalledWith(
          '/h/host/session/route?paneKey=group%3A11111111-1111-4111-8111-111111111111'
        )
        expect(navigation.back).not.toHaveBeenCalled()
      } else {
        expect(navigation.back).toHaveBeenCalled()
        expect(navigation.shellOpen).not.toHaveBeenCalled()
      }
      expect(navigation.replace).not.toHaveBeenCalled()
    }
  )

  it('keeps an unconfirmed handoff destination available to open without launching again', async () => {
    const selected = historySession()
    const client = historyClient(selected, async (method) =>
      method === 'agent.launchReplay'
        ? {
            id: 'reply',
            ok: true,
            result: {
              outcome: { kind: 'terminal', handle: 'pty', paneKey: `group:${LEAF}` },
              worktreeId: 'route',
              receipt: {
                mode: 'terminal',
                preferred: 'terminal',
                reason: 'user_default',
                detail: 'CLI'
              },
              prompt: { delivery: 'submit', outcome: 'unconfirmed' }
            }
          }
        : undefined
    )
    await withResume(client, async (resume, current) => {
      await resume(selected, { kind: 'handoff', agent: 'codex', worktreeId: 'repo::/repo' })
      expect(navigation.shellOpen).not.toHaveBeenCalled()
      const open = current().openUnconfirmedContinuation
      if (!open) {
        throw new Error('The created session has no open action')
      }
      act(() => open())
      expect(navigation.shellOpen).toHaveBeenCalledWith(
        '/h/host/session/route?paneKey=group%3A11111111-1111-4111-8111-111111111111'
      )
    })
  })

  it('does not launch a stale row when only another host still lists that id', async () => {
    const selected = session('claude')
    const writes: string[] = []
    const client = stubRpcClient({
      sendRequest: async (method) => {
        if (method === 'aiVault.listSessions') {
          return success({ sessions: [{ ...selected, executionHostId: 'ssh:other' }], issues: [] })
        }
        writes.push(method)
        throw new Error(`unexpected request: ${method}`)
      }
    })
    await withResume(client, (resume) => resume(selected, { kind: 'cli' }))
    expect(writes).toEqual([])
    expect(navigation.replace).not.toHaveBeenCalled()
  })
})
