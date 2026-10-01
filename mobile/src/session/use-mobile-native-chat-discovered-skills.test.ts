import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useMobileNativeChatDiscoveredSkills } from './use-mobile-native-chat-discovered-skills'

// Every test client here answers through sendRequest alone; the rest of RpcClient is streaming
// and lifecycle the hook never touches.
function rpcClientWith(sendRequest: RpcClient['sendRequest']): RpcClient {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: sendRequest is the only member useMobileNativeChatDiscoveredSkills reads.
  return { sendRequest } as unknown as RpcClient
}

function discoveredSkillRow() {
  return {
    id: 'claude:deploy-check',
    name: 'deploy-check',
    description: 'Verify the deploy',
    providers: ['claude' as const],
    sourceKind: 'repo' as const,
    sourceLabel: 'Project',
    rootPath: '/repo/.claude/skills',
    directoryPath: '/repo/.claude/skills/deploy-check',
    skillFilePath: '/repo/.claude/skills/deploy-check/SKILL.md',
    installed: true,
    updatedAt: null
  }
}

// A source row as the host really sends it: the checked read requires every field
// SkillDiscoverySource declares, so a partial fixture would fail as an incompatible reply.
function discoveredSkillSourceRow() {
  return {
    id: 'repo:/repo/.claude/skills',
    label: 'Project',
    path: '/repo/.claude/skills',
    sourceKind: 'repo' as const,
    providers: ['claude' as const],
    owner: 'claude',
    exists: true
  }
}

describe('useMobileNativeChatDiscoveredSkills', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: ReturnType<typeof useMobileNativeChatDiscoveredSkills> | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    hook = null
  })

  function render(client: RpcClient | null, agent: string | null) {
    function Harness(): null {
      hook = useMobileNativeChatDiscoveredSkills({ client, worktreeId: 'wt-1', agent })
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
  }

  it('discovers worktree skills for the agent and maps them to described rows', async () => {
    const skill = discoveredSkillRow()
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: '1',
      ok: true,
      result: { skills: [skill], sources: [discoveredSkillSourceRow()] },
      _meta: { runtimeId: 'runtime-1' }
    }))
    render(rpcClientWith(sendRequest), 'claude')

    await vi.waitFor(() => expect(hook?.skillSuggestions.length).toBe(1))
    expect(hook!.skillSuggestions[0]).toEqual({
      name: 'deploy-check',
      description: 'Verify the deploy'
    })
    expect(sendRequest).toHaveBeenCalledWith('skills.discover', { worktreeId: 'wt-1' })
  })

  it('namespaces a plugin-sourced skill the way the agent addresses it', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: '1',
      ok: true,
      result: {
        skills: [
          {
            ...discoveredSkillRow(),
            name: 'catchup',
            sourceKind: 'plugin',
            sourceLabel: 'Claude plugin quiver'
          }
        ],
        sources: [discoveredSkillSourceRow()]
      },
      _meta: { runtimeId: 'runtime-1' }
    }))
    render(rpcClientWith(sendRequest), 'claude')

    await vi.waitFor(() => expect(hook?.skillSuggestions.length).toBe(1))
    expect(hook!.skillSuggestions[0]).toMatchObject({ name: 'quiver:catchup' })
  })

  it('stays empty against a host without the method or on any failure', async () => {
    const sendRequest = vi.fn(async (): Promise<RpcResponse> => ({
      id: '1',
      ok: false,
      error: { code: 'forbidden', message: 'Method not available to mobile clients' }
    }))
    render(rpcClientWith(sendRequest), 'claude')

    await act(async () => {
      await Promise.resolve()
    })
    expect(hook?.skillSuggestions).toEqual([])
  })
})
