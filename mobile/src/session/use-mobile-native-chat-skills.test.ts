import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentType } from '../../../src/shared/agent-status-types'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../src/shared/skills'
import type { RpcClient } from '../transport/rpc-client'
import {
  resetMobileNativeChatSkillDiscoveryCacheForTests,
  useMobileNativeChatSkills,
  type MobileNativeChatSkillDiscovery
} from './use-mobile-native-chat-skills'

function skill(name: string, rootPath: string): DiscoveredSkill {
  return {
    id: name,
    name,
    description: `${name} description`,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Skills',
    rootPath,
    directoryPath: `${rootPath}/${name}`,
    skillFilePath: `${rootPath}/${name}/SKILL.md`,
    installed: true,
    fileCount: 1,
    updatedAt: null
  }
}

function result(): SkillDiscoveryResult {
  const sharedRoot = '/skills/shared'
  const codexRoot = '/skills/codex'
  const claudeRoot = '/skills/claude'
  return {
    skills: [
      skill('shared-skill', sharedRoot),
      skill('codex-skill', codexRoot),
      skill('claude-skill', claudeRoot)
    ],
    sources: [
      source('shared', sharedRoot, null),
      source('codex', codexRoot, 'codex'),
      source('claude', claudeRoot, 'claude')
    ],
    scannedAt: 1
  }
}

function source(id: string, path: string, owner: AgentType | null) {
  return {
    id,
    label: id,
    path,
    sourceKind: 'home' as const,
    providers: ['agent-skills' as const],
    owner,
    exists: true
  }
}

function success(discovery = result()): Awaited<ReturnType<RpcClient['sendRequest']>> {
  return {
    id: 'skills',
    ok: true,
    result: discovery,
    _meta: { runtimeId: 'runtime-1' }
  }
}

describe('useMobileNativeChatSkills', () => {
  let renderer: ReactTestRenderer | null = null
  let state: MobileNativeChatSkillDiscovery | null = null
  let harnessProps: { client: RpcClient; worktreeId: string; agent: AgentType }

  function Harness(): null {
    state = useMobileNativeChatSkills(harnessProps)
    return null
  }

  async function mount(client: RpcClient, agent: AgentType = 'codex'): Promise<void> {
    harnessProps = { client, worktreeId: 'wt-1', agent }
    const restore = suppressRendererWarning()
    try {
      await act(async () => {
        renderer = create(createElement(Harness))
      })
    } finally {
      restore()
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    resetMobileNativeChatSkillDiscoveryCacheForTests()
    state = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.useRealTimers()
  })

  it('debounces discovery, scopes by owner, and caches by client and worktree', async () => {
    const sendRequest = vi.fn().mockResolvedValue(success())
    const client = { sendRequest } as unknown as RpcClient
    await mount(client)

    expect(state?.status).toBe('loading')
    await act(async () => vi.advanceTimersByTimeAsync(119))
    expect(sendRequest).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(1))

    expect(sendRequest).toHaveBeenCalledWith(
      'skills.discover',
      { worktreeId: 'wt-1' },
      { timeoutMs: 30_000 }
    )
    expect(state?.status).toBe('ready')
    expect(state?.skills.map((entry) => entry.name)).toEqual(['shared-skill', 'codex-skill'])

    act(() => {
      harnessProps = { ...harnessProps, agent: 'claude' }
      renderer?.update(createElement(Harness))
    })
    expect(state?.skills.map((entry) => entry.name)).toEqual(['shared-skill', 'claude-skill'])
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it.each([
    {
      name: 'unavailable',
      response: {
        id: 'missing',
        ok: false as const,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'runtime-1' }
      },
      expected: 'unavailable'
    },
    {
      name: 'timeout',
      response: new Error('Request timed out: skills.discover'),
      expected: 'timeout'
    },
    { name: 'unknown', response: new Error('Connection interrupted'), expected: 'unknown' }
  ])('surfaces $name failures without throwing', async ({ response, expected }) => {
    const sendRequest =
      response instanceof Error
        ? vi.fn().mockRejectedValue(response)
        : vi.fn().mockResolvedValue(response)
    await mount({ sendRequest } as unknown as RpcClient)

    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(state).toMatchObject({ status: 'error', errorKind: expected, skills: [] })
  })

  it('drops a late response after the worktree changes', async () => {
    let resolveFirst: (value: Awaited<ReturnType<RpcClient['sendRequest']>>) => void = () => {}
    const first = new Promise<Awaited<ReturnType<RpcClient['sendRequest']>>>((resolve) => {
      resolveFirst = resolve
    })
    const secondResult = result()
    secondResult.skills = [skill('new-worktree', '/skills/shared')]
    const sendRequest = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(success(secondResult))
    await mount({ sendRequest } as unknown as RpcClient)
    await act(async () => vi.advanceTimersByTimeAsync(120))

    act(() => {
      harnessProps = { ...harnessProps, worktreeId: 'wt-2' }
      renderer?.update(createElement(Harness))
    })
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(state?.skills.map((entry) => entry.name)).toEqual(['new-worktree'])

    await act(async () => {
      resolveFirst(success())
      await Promise.resolve()
    })
    expect(state?.skills.map((entry) => entry.name)).toEqual(['new-worktree'])
  })

  it('evicts the cached result when retrying', async () => {
    const sendRequest = vi.fn().mockResolvedValue(success())
    await mount({ sendRequest } as unknown as RpcClient)
    await act(async () => vi.advanceTimersByTimeAsync(120))

    act(() => state?.retry())
    expect(state?.status).toBe('loading')
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })
})

function suppressRendererWarning(): () => void {
  const original = console.error
  const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && args[0].includes('react-test-renderer is deprecated')) {
      return
    }
    original(...args)
  })
  return () => spy.mockRestore()
}
