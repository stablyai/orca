import { expect, it } from 'vitest'
import { CreateTerminalTab } from '../../../src/shared/rpc-contract/session-tabs/session-tabs-schemas-params'
import {
  createMobileAiVaultResumeMutationRegistry,
  resumeAiVaultSessionInTerminal
} from './ai-vault-resume-launch'
import {
  continueMobileHistorySession,
  MobileHistoryHandoffWorkspaceChanged
} from './mobile-history-session-continuation'
import { historyClient, historySession } from './mobile-history-test-fixture'
import type { PendingMobileHistoryHandoff } from './mobile-history-session-handoff'
import { structuredSessionOperationId } from '../session/native-chat/agent-session/structured-session-operation-id'

it('accepts a resumed pane while the host is still publishing its terminal handle', async () => {
  const client = historyClient(historySession(), async (method) =>
    method === 'session.tabs.createTerminal'
      ? {
          id: 'created',
          ok: true,
          result: {
            tab: {
              type: 'terminal',
              id: 'pending-tab',
              parentTabId: 'group',
              leafId: '11111111-1111-4111-8111-111111111111',
              status: 'pending-handle',
              terminal: null
            }
          }
        }
      : undefined
  )
  await expect(
    resumeAiVaultSessionInTerminal(client, 'repo::/repo', {
      command: 'claude --resume source',
      clientMutationId: structuredSessionOperationId(),
      hostCapabilities: ['session.tabs.owned-startup.v1']
    })
  ).resolves.toMatchObject({
    id: 'pending-tab',
    parentTabId: 'group',
    leafId: '11111111-1111-4111-8111-111111111111',
    terminal: null
  })
})

it('requires host-owned startup before creating a history terminal on an older host', async () => {
  const requests: string[] = []
  const client = historyClient(historySession(), async (method) => {
    requests.push(method)
  })
  await expect(
    resumeAiVaultSessionInTerminal(client, 'repo::/repo', {
      command: 'claude --resume provider',
      clientMutationId: structuredSessionOperationId(),
      hostCapabilities: []
    })
  ).rejects.toThrow('Update Orca on this host')
  expect(requests).toEqual([])
})

it('retries a lost CLI reply with the original startup even when host settings change', async () => {
  let override = 'original-claude'
  const requests: unknown[] = []
  const client = historyClient(historySession(), async (method, params) => {
    if (method === 'settings.get') {
      return {
        id: 'settings',
        ok: true,
        result: { settings: { agentCmdOverrides: { claude: override } } }
      }
    }
    if (method === 'session.tabs.createTerminal') {
      requests.push(CreateTerminalTab.parse(params))
      if (requests.length === 1) {
        throw new Error('reply lost')
      }
      return {
        id: 'created',
        ok: true,
        result: { tab: { type: 'terminal', id: 'tab', terminal: 'pty' } }
      }
    }
  })
  const args = {
    client,
    session: historySession(),
    worktreeId: 'repo::/repo',
    worktrees: [],
    mutations: createMobileAiVaultResumeMutationRegistry(() => structuredSessionOperationId()),
    handoffs: new Map(),
    assertCurrentOwner: () => {},
    action: { kind: 'cli' as const }
  }
  await expect(continueMobileHistorySession(args)).rejects.toThrow('reply lost')
  override = 'new-claude'
  await expect(continueMobileHistorySession(args)).resolves.toMatchObject({ terminal: 'pty' })
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
  expect(requests[0]).toMatchObject({
    command: expect.stringContaining('original-claude'),
    requireOwnedStartup: true
  })
})

it('uses a new fork identity when the history row switches source chats after a lost reply', async () => {
  const mutations = createMobileAiVaultResumeMutationRegistry(() => crypto.randomUUID())
  const creates = new Map<string, string>()
  const client = historyClient(historySession(), async (method, params) => {
    if (method !== 'session.tabs.createTerminal') {
      return
    }
    const request = CreateTerminalTab.parse(params)
    if (!request.clientMutationId || !request.sourceChatFork) {
      throw new Error('missing fork identity')
    }
    const owner = creates.get(request.clientMutationId) ?? request.sourceChatFork.sessionId
    creates.set(request.clientMutationId, owner)
    if (owner === 'first') {
      throw new Error('first reply lost')
    }
    return {
      id: 'reply',
      ok: true,
      result: { tab: { type: 'terminal', id: 'tab', terminal: `pty-${owner}` } }
    }
  })
  const args = {
    client,
    worktreeId: 'repo::/repo',
    worktrees: [],
    mutations,
    handoffs: new Map(),
    assertCurrentOwner: () => {},
    action: { kind: 'cli' as const }
  }
  await expect(
    continueMobileHistorySession({
      ...args,
      session: historySession({
        structuredSession: { sessionId: 'first', workspaceId: 'repo::/repo' }
      })
    })
  ).rejects.toThrow('first reply lost')
  await expect(
    continueMobileHistorySession({
      ...args,
      session: historySession({
        structuredSession: { sessionId: 'second', workspaceId: 'repo::/repo' }
      })
    })
  ).resolves.toMatchObject({ terminal: 'pty-second' })
})

it('replays the original handoff snapshot after a lost reply even if the source gains a turn', async () => {
  let lost = true
  let prompt: unknown
  const client = historyClient(historySession(), async (method, params) => {
    if (method !== 'agent.launchReplay') {
      return
    }
    if (params && typeof params === 'object' && 'prompt' in params) {
      prompt = params.prompt
    }
    if (lost) {
      throw new Error('reply lost')
    }
  })
  const args = {
    client,
    worktreeId: 'repo::/repo',
    worktrees: [],
    mutations: createMobileAiVaultResumeMutationRegistry(() => 'same-operation'),
    handoffs: new Map<string, PendingMobileHistoryHandoff>(),
    assertCurrentOwner: () => {},
    action: { kind: 'handoff' as const, agent: 'codex' as const, worktreeId: 'repo::/repo' }
  }
  await expect(
    continueMobileHistorySession({ ...args, session: historySession() })
  ).rejects.toThrow()
  lost = false
  await expect(
    continueMobileHistorySession({
      ...args,
      session: historySession({
        previewMessages: [
          { role: 'assistant', text: 'New context after the lost reply', timestamp: null }
        ]
      })
    })
  ).resolves.toMatchObject({ terminal: 'pty' })
  expect(prompt).toMatchObject({ text: expect.stringContaining('Original context') })
  expect(prompt).not.toMatchObject({
    text: expect.stringContaining('New context after the lost reply')
  })
})

it('asks for a new agent choice before launching into a workspace different from detection', async () => {
  const source = historySession()
  await expect(
    continueMobileHistorySession({
      client: historyClient(source),
      session: source,
      worktreeId: 'repo::/repo',
      worktrees: [],
      mutations: createMobileAiVaultResumeMutationRegistry(() => 'operation'),
      handoffs: new Map(),
      assertCurrentOwner: () => {},
      action: { kind: 'handoff', agent: 'codex', worktreeId: 'previous-workspace' }
    })
  ).rejects.toBeInstanceOf(MobileHistoryHandoffWorkspaceChanged)
})
