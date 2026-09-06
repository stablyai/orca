import { describe, expect, it, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../src/shared/terminal-quick-command-types'
import type { RpcClient } from '../transport/rpc-client'
import { executeMobileWebSessionQuickCommandOperation } from './mobile-web-session-quick-command-operations'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const HOST_REPO_ID = 'host-repo-private'
const HOST_WORKSPACE_ID = `${HOST_REPO_ID}::/secret/worktree`
const OTHER_REPO_ID = 'other-repo-private'
const REQUEST_ID = 'R'.repeat(22)

const GLOBAL_COMMAND: TerminalQuickCommand = {
  id: 'global-command',
  label: 'Global',
  action: 'terminal-command',
  command: 'pwd',
  appendEnter: true,
  scope: { type: 'global' }
}
const REPO_COMMAND: TerminalQuickCommand = {
  id: 'repo-command',
  label: 'Repository',
  action: 'terminal-command',
  command: 'git status',
  appendEnter: true,
  scope: { type: 'repo', repoId: HOST_REPO_ID }
}
const OTHER_REPO_COMMAND: TerminalQuickCommand = {
  id: 'other-command',
  label: 'Other',
  action: 'terminal-command',
  command: 'git log',
  appendEnter: true,
  scope: { type: 'repo', repoId: OTHER_REPO_ID }
}

describe('mobile web session quick-command operations', () => {
  it('projects only global and current-repository commands through opaque scope', async () => {
    const { authority, pageWorkspaceId } = createAuthority()
    const client = createClient(async (method) => {
      expect(method).toBe('settings.getTerminalQuickCommands')
      return quickCommandsResponse([GLOBAL_COMMAND, REPO_COMMAND, OTHER_REPO_COMMAND])
    })

    const result = await execute(
      'quickCommands',
      { workspaceId: pageWorkspaceId },
      client,
      authority
    )

    expect(result).toEqual({
      commands: [
        GLOBAL_COMMAND,
        {
          ...REPO_COMMAND,
          scope: { type: 'repo', repoId: pageWorkspaceId }
        }
      ],
      totalCount: 3,
      repoId: pageWorkspaceId
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(HOST_REPO_ID)
    expect(serialized).not.toContain(HOST_WORKSPACE_ID)
    expect(serialized).not.toContain(OTHER_REPO_ID)
  })

  it('maps an opaque upsert to the host repository without replacing unrelated commands', async () => {
    const { authority, pageWorkspaceId } = createAuthority()
    const updated = { ...REPO_COMMAND, label: 'Updated' }
    const sendRequest = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'settings.getTerminalQuickCommands') {
        return quickCommandsResponse([REPO_COMMAND, OTHER_REPO_COMMAND])
      }
      expect(method).toBe('settings.updateTerminalQuickCommands')
      expect(params).toEqual({
        mutation: {
          type: 'upsert',
          command: updated
        }
      })
      return quickCommandsResponse([updated, OTHER_REPO_COMMAND])
    })
    const client = { sendRequest } as unknown as RpcClient

    const result = await execute(
      'quickCommandMutate',
      {
        workspaceId: pageWorkspaceId,
        mutation: {
          type: 'upsert',
          command: {
            ...updated,
            scope: { type: 'repo', repoId: pageWorkspaceId }
          }
        }
      },
      client,
      authority
    )

    expect(result).toEqual({
      commands: [{ ...updated, scope: { type: 'repo', repoId: pageWorkspaceId } }],
      totalCount: 2,
      repoId: pageWorkspaceId
    })
  })

  it('rejects guessed deletes and upserts belonging to another repository', async () => {
    const { authority, pageWorkspaceId } = createAuthority()
    const client = createClient(async () => quickCommandsResponse([OTHER_REPO_COMMAND]))

    await expect(
      execute(
        'quickCommandMutate',
        {
          workspaceId: pageWorkspaceId,
          mutation: { type: 'delete', id: OTHER_REPO_COMMAND.id }
        },
        client,
        authority
      )
    ).rejects.toMatchObject({ code: 'invalid_request' })
    await expect(
      execute(
        'quickCommandMutate',
        {
          workspaceId: pageWorkspaceId,
          mutation: {
            type: 'upsert',
            command: {
              ...OTHER_REPO_COMMAND,
              scope: { type: 'repo', repoId: pageWorkspaceId }
            }
          }
        },
        client,
        authority
      )
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })

  it('re-reads executable command content and requests shell-ready delivery', async () => {
    const { authority, pageWorkspaceId } = createAuthority()
    const current = { ...REPO_COMMAND, command: 'pnpm test\npnpm lint' }
    const sendRequest = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'settings.getTerminalQuickCommands') {
        return quickCommandsResponse([current])
      }
      expect(method).toBe('session.tabs.createTerminal')
      expect(params).toEqual({
        worktree: `id:${HOST_WORKSPACE_ID}`,
        activate: true,
        select: true,
        navigation: 'caller',
        clientMutationId: REQUEST_ID,
        command: 'pnpm test; pnpm lint',
        startupCommandDelivery: 'shell-ready'
      })
      return createdTerminalResponse()
    })

    await expect(
      execute(
        'createQuickCommand',
        { workspaceId: pageWorkspaceId, commandId: current.id },
        { sendRequest } as unknown as RpcClient,
        authority
      )
    ).resolves.toEqual({
      workspaceId: pageWorkspaceId,
      tabId: 'terminal-1',
      created: true,
      initialInput: null
    })
  })

  it('returns bounded initial input without sending command text in create parameters', async () => {
    const { authority, pageWorkspaceId } = createAuthority()
    const insertOnly = { ...REPO_COMMAND, command: 'git status', appendEnter: false }
    const sendRequest = vi.fn(async (method: string, params?: unknown) => {
      if (method === 'settings.getTerminalQuickCommands') {
        return quickCommandsResponse([insertOnly])
      }
      expect(params).not.toHaveProperty('command')
      return createdTerminalResponse()
    })

    await expect(
      execute(
        'createQuickCommand',
        { workspaceId: pageWorkspaceId, commandId: insertOnly.id },
        { sendRequest } as unknown as RpcClient,
        authority
      )
    ).resolves.toEqual({
      workspaceId: pageWorkspaceId,
      tabId: 'terminal-1',
      created: true,
      initialInput: {
        text: 'git status',
        enter: false,
        successToast: 'Repository inserted'
      }
    })
  })

  it('freshly revalidates agent settings and detection before launch', async () => {
    const { authority, pageWorkspaceId } = createAuthority()
    const command: TerminalQuickCommand = {
      id: 'agent-command',
      label: 'Ask Codex',
      action: 'agent-prompt',
      agent: 'codex',
      prompt: 'Fix the test',
      scope: { type: 'global' }
    }
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'settings.getTerminalQuickCommands') {
        return quickCommandsResponse([command])
      }
      if (method === 'repo.list') {
        return { ok: true, result: { repos: [{ id: HOST_REPO_ID, connectionId: null }] } }
      }
      if (method === 'settings.get') {
        return {
          ok: true,
          result: {
            settings: { defaultTuiAgent: 'codex', disabledTuiAgents: ['codex'] }
          }
        }
      }
      if (method === 'preflight.detectAgents') {
        return { ok: true, result: ['codex'] }
      }
      throw new Error(`Unexpected method: ${method}`)
    })

    await expect(
      execute(
        'createQuickCommand',
        { workspaceId: pageWorkspaceId, commandId: command.id },
        { sendRequest } as unknown as RpcClient,
        authority
      )
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(sendRequest).not.toHaveBeenCalledWith('session.tabs.createTerminal', expect.anything())
  })

  it('rejects a command removed before launch', async () => {
    const { authority, pageWorkspaceId } = createAuthority()
    const client = createClient(async () => quickCommandsResponse([]))

    await expect(
      execute(
        'createQuickCommand',
        { workspaceId: pageWorkspaceId, commandId: REPO_COMMAND.id },
        client,
        authority
      )
    ).rejects.toMatchObject({ code: 'invalid_request' })
  })
})

function createAuthority() {
  const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
  authority.synchronize([{ workspaceId: HOST_WORKSPACE_ID, repoId: HOST_REPO_ID }])
  return {
    authority,
    pageWorkspaceId: authority.pageWorkspaceId(HOST_WORKSPACE_ID)
  }
}

function createClient(handler: (method: string, params?: unknown) => Promise<unknown>): RpcClient {
  return { sendRequest: vi.fn(handler) } as unknown as RpcClient
}

function execute(
  operation: string,
  payload: unknown,
  client: RpcClient,
  workspaceAuthority: MobileWebWorkspaceAuthority
) {
  return executeMobileWebSessionQuickCommandOperation({
    operation,
    payload,
    requestId: REQUEST_ID,
    client,
    workspaceAuthority
  })
}

function quickCommandsResponse(commands: TerminalQuickCommand[]) {
  return { ok: true, result: { terminalQuickCommands: commands } }
}

function createdTerminalResponse() {
  return {
    ok: true,
    result: { tab: { id: 'terminal-1', type: 'terminal' }, terminal: 'secret-handle' }
  }
}
