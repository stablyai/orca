import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { createStableLogicalRpcClient } from '../../../transport/stable-logical-rpc-client'
import { stubRpcClient } from '../../../transport/rpc-client-test-stub'
import type { RpcResponse } from '../../../transport/types'
import { useMobileNativeChatSkills } from './use-mobile-native-chat-skills'

const firstWorkspace = 'folder:skills-bound-first'
const secondWorkspace = 'folder:skills-bound-second'
const hook: { current: ReturnType<typeof useMobileNativeChatSkills> | null } = { current: null }
let renderer: ReactTestRenderer | null = null
const cleanups: (() => void)[] = []
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  cleanups.splice(0).forEach((cleanup) => cleanup())
})
function reply(generation: number): RpcResponse {
  return {
    id: 'skills',
    ok: true,
    result: {
      skills: [
        {
          id: 'skill',
          name: `skill-${generation}`,
          description: null,
          providers: ['agent-skills'],
          sourceKind: 'home',
          sourceLabel: 'Home',
          rootPath: '/skills',
          directoryPath: '/skills/skill',
          skillFilePath: '/skills/skill/SKILL.md',
          installed: true,
          updatedAt: null
        }
      ],
      sources: [
        {
          id: '/skills',
          label: 'Skills',
          path: '/skills',
          sourceKind: 'home',
          providers: ['agent-skills'],
          owner: null,
          exists: true
        }
      ],
      scannedAt: generation
    }
  }
}

it.each([10, 100])(
  'retains only this transport generation after %i skill-menu scan rounds',
  async (rounds) => {
    let requests = 0
    let generation = 1
    const physical = () =>
      stubRpcClient({
        sendRequest: async (method) => {
          expect(method).toBe('skills.discover')
          requests += 1
          return reply(generation)
        }
      })
    const client = createStableLogicalRpcClient(physical(), 'relay')
    cleanups.push(() => client.close())
    const writes = vi.spyOn(Map.prototype, 'set')
    cleanups.push(() => writes.mockRestore())
    function Probe({ worktreeId }: { worktreeId: string }): null {
      hook.current = useMobileNativeChatSkills({
        client,
        worktreeId,
        agent: 'codex',
        supported: true
      })
      return null
    }
    async function show(worktreeId: string): Promise<void> {
      await act(async () => {
        if (renderer) {
          renderer.update(createElement(Probe, { worktreeId }))
        } else {
          renderer = create(createElement(Probe, { worktreeId }))
        }
      })
      await act(async () => {
        hook.current?.loadNativeChatSkills()
      })
      expect(hook.current?.nativeChatSkills).toMatchObject({
        status: 'ready',
        skills: [{ name: `skill-${generation}` }]
      })
    }
    for (let round = 0; round < rounds; round += 1) {
      if (round > 0) {
        generation += 1
        await act(async () => {
          await client.migrateTo(physical(), 'lan')
        })
      }
      await show(firstWorkspace)
      await show(secondWorkspace)
      await show(firstWorkspace)
    }
    expect(requests).toBe(rounds * 2)
    expect(client.getGeneration()).toBe(rounds)
    const cacheWrite = writes.mock.calls.findLastIndex(
      ([key, value]) =>
        typeof key === 'string' &&
        key.endsWith(secondWorkspace) &&
        typeof value === 'object' &&
        value !== null &&
        'status' in value
    )
    expect(cacheWrite).toBeGreaterThanOrEqual(0)
    const cache = writes.mock.contexts[cacheWrite]
    if (!(cache instanceof Map)) {
      throw new Error('Did not observe the skill-scan cache owner')
    }
    expect(cache.size).toBeLessThanOrEqual(2)
  }
)

it('retries a current failure and ignores an old transport reply after recovery', async () => {
  const release: { current: ((response: RpcResponse) => void) | null } = { current: null }
  const client = createStableLogicalRpcClient(
    stubRpcClient({
      sendRequest: () =>
        new Promise((resolve) => {
          release.current = resolve
        })
    }),
    'relay'
  )
  cleanups.push(() => client.close())
  function Probe(): null {
    hook.current = useMobileNativeChatSkills({
      client,
      worktreeId: firstWorkspace,
      agent: 'codex',
      supported: true
    })
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe))
  })
  act(() => hook.current?.loadNativeChatSkills())
  let reads = 0
  await act(async () => {
    await client.migrateTo(
      stubRpcClient({
        sendRequest: async (): Promise<RpcResponse> => {
          reads += 1
          return reads === 1
            ? { id: 'failed', ok: false, error: { code: 'unavailable', message: 'Retry' } }
            : reply(2)
        }
      }),
      'lan'
    )
    renderer?.update(createElement(Probe))
  })
  await act(async () => {
    hook.current?.loadNativeChatSkills()
  })
  expect(hook.current?.nativeChatSkills.status).toBe('error')
  await act(async () => {
    hook.current?.loadNativeChatSkills()
  })
  expect(hook.current?.nativeChatSkills).toMatchObject({
    status: 'ready',
    skills: [{ name: 'skill-2' }]
  })
  await act(async () => {
    release.current?.(reply(1))
  })
  expect(hook.current?.nativeChatSkills).toMatchObject({
    status: 'ready',
    skills: [{ name: 'skill-2' }]
  })
  await act(async () => {
    hook.current?.loadNativeChatSkills()
  })
  expect(reads).toBe(2)
})

it('keeps a current reply when the menu opens after an unrendered migration', async () => {
  const client = createStableLogicalRpcClient(
    stubRpcClient({ sendRequest: async () => reply(1) }),
    'relay'
  )
  cleanups.push(() => client.close())
  function Probe(): null {
    hook.current = useMobileNativeChatSkills({
      client,
      worktreeId: firstWorkspace,
      agent: 'codex',
      supported: true
    })
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe))
  })
  await act(async () => {
    await client.migrateTo(stubRpcClient({ sendRequest: async () => reply(2) }), 'lan')
  })
  await act(async () => {
    hook.current?.loadNativeChatSkills()
  })
  expect(hook.current?.nativeChatSkills).toMatchObject({
    status: 'ready',
    skills: [{ name: 'skill-2' }]
  })
})
