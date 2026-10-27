import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../../../transport/rpc-client'
import { useMobileNativeChatSkills } from './use-mobile-native-chat-skills'

function skill(name: string, rootPath: string) {
  return {
    id: name,
    name,
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Home',
    rootPath,
    directoryPath: `${rootPath}/${name}`,
    skillFilePath: `${rootPath}/${name}/SKILL.md`,
    installed: true,
    updatedAt: null
  }
}

function source(path: string, owner: string | null) {
  return {
    id: path,
    label: path,
    path,
    sourceKind: 'home',
    providers: ['agent-skills'],
    owner,
    exists: true
  }
}

const reply = {
  id: 'skills',
  ok: true as const,
  result: {
    skills: [skill('shared', '/home/.agents/skills'), skill('claude-only', '/home/.claude/skills')],
    sources: [source('/home/.agents/skills', null), source('/home/.claude/skills', 'claude')],
    scannedAt: 1
  },
  _meta: { runtimeId: 'runtime-1' }
}

function fakeClient(sendRequest: unknown): RpcClient {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The hook calls `sendRequest` and `getGeneration` and nothing else on the client; every other member is unreachable from it.
  return { sendRequest } as RpcClient
}

describe('useMobileNativeChatSkills', () => {
  let renderer: ReactTestRenderer | null = null
  let state: ReturnType<typeof useMobileNativeChatSkills> | null = null

  async function mount(client: RpcClient, supported: boolean): Promise<void> {
    function Harness(): null {
      state = useMobileNativeChatSkills({ client, worktreeId: 'wt-1', agent: 'codex', supported })
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
  }

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  it("asks the host to scan the workspace once, keeping the agent's own skills", async () => {
    const sendRequest = vi.fn(async () => reply)
    await mount(fakeClient(sendRequest), true)

    await act(async () => state?.loadNativeChatSkills())
    await act(async () => state?.loadNativeChatSkills())

    expect(sendRequest).toHaveBeenCalledExactlyOnceWith('skills.discover', { worktreeId: 'wt-1' })
    expect(state?.nativeChatSkills.skills.map((entry) => entry.name)).toEqual(['shared'])
  })

  it('lists none from a host that needs the folder the phone does not know', async () => {
    const sendRequest = vi.fn(async () => reply)
    await mount(fakeClient(sendRequest), false)

    await act(async () => state?.loadNativeChatSkills())

    expect(sendRequest).not.toHaveBeenCalled()
    expect(state?.nativeChatSkills.skills).toEqual([])
  })
})
