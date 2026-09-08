import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileNativeChatDiscoveredSkills } from './use-mobile-native-chat-discovered-skills'

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
    const sendRequest = vi.fn(async () => ({
      ok: true,
      result: { skills: [skill], sources: [{ path: '/repo/.claude/skills', owner: 'claude' }] },
      _meta: { runtimeId: 'runtime-1' }
    }))
    render({ sendRequest } as unknown as RpcClient, 'claude')

    await vi.waitFor(() => expect(hook?.skillSuggestions.length).toBe(1))
    expect(hook!.skillSuggestions[0]).toEqual({
      name: 'deploy-check',
      description: 'Verify the deploy'
    })
    expect(sendRequest).toHaveBeenCalledWith('skills.discover', { worktreeId: 'wt-1' })
  })

  it('stays empty against a host without the method or on any failure', async () => {
    const sendRequest = vi.fn(async () => ({
      ok: false,
      error: { code: 'forbidden', message: 'Method not available to mobile clients' }
    }))
    render({ sendRequest } as unknown as RpcClient, 'claude')

    await act(async () => {
      await Promise.resolve()
    })
    expect(hook?.skillSuggestions).toEqual([])
  })
})
