import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import { useLiveWorktreeName, type LiveWorktreeName } from '../worktree/use-live-worktree-name'

vi.mock('expo-router', async () => {
  const React = await import('react')
  return {
    useFocusEffect(effect: () => void | (() => void)): void {
      React.useEffect(effect, [effect])
    }
  }
})

let renderer: ReactTestRenderer | null = null
let live: LiveWorktreeName | undefined

function Harness({ client }: { client: FakeRpcClient }): null {
  live = useLiveWorktreeName({
    client,
    connState: 'connected',
    routeName: 'master',
    worktreeId: 'repo-1::/worktree'
  })
  return null
}

async function mount(client: FakeRpcClient): Promise<void> {
  await act(async () => {
    renderer = create(createElement(Harness, { client }))
  })
}

function latestRequest(client: FakeRpcClient, method: string) {
  const request = client.requests.findLast((entry) => entry.method === method)
  if (!request) {
    throw new Error(`Missing ${method} request`)
  }
  return request
}

async function reply(client: FakeRpcClient, method: string, result: unknown) {
  const request = latestRequest(client, method)
  await act(async () => {
    request.resolve({ id: method, ok: true, result, _meta: { runtimeId: 'fixture-runtime' } })
  })
  return request
}

async function replyWorkspace(client: FakeRpcClient): Promise<void> {
  await reply(client, 'worktree.show', {
    worktree: {
      id: 'repo-1::/worktree',
      displayName: 'master',
      hostId: 'ssh:target'
    }
  })
}

async function renameEvent(client: FakeRpcClient): Promise<void> {
  const stream = client.streams.find((entry) => entry.method === 'runtime.clientEvents.subscribe')
  if (!stream) {
    throw new Error('Missing workspace event subscription')
  }
  await act(async () => {
    stream.emit({ type: 'reposChanged' })
  })
  await replyWorkspace(client)
}

beforeEach(() => {
  vi.useFakeTimers()
  live = undefined
})

afterEach(async () => {
  await act(async () => renderer?.unmount())
  renderer = null
  vi.useRealTimers()
})

it('resolves the owner project and refreshes renamed or cleared project names', async () => {
  const client = createFakeRpcClient()
  await mount(client)
  await replyWorkspace(client)
  const project = await reply(client, 'repo.show', { repo: { displayName: 'orca' } })
  expect(project.args[1]).toEqual({ repo: 'id:repo-1', repoHostId: 'ssh:target' })
  expect(live).toMatchObject({ name: 'master', projectName: 'orca' })

  await renameEvent(client)
  await reply(client, 'repo.show', { repo: { displayName: 'Renamed project' } })
  expect(live?.projectName).toBe('Renamed project')

  await renameEvent(client)
  await reply(client, 'repo.show', { repo: { displayName: '   ' } })
  expect(live).toMatchObject({ name: 'master', projectName: null })
})

it('hides another client project and ignores its late reply for the same workspace id', async () => {
  const first = createFakeRpcClient()
  await mount(first)
  await replyWorkspace(first)
  await reply(first, 'repo.show', { repo: { displayName: 'First project' } })
  expect(live).toMatchObject({ projectName: 'First project' })
  await renameEvent(first)
  const late = latestRequest(first, 'repo.show')

  const second = createFakeRpcClient()
  await act(async () => renderer?.update(createElement(Harness, { client: second })))
  expect(live).toMatchObject({ projectName: null })
  await replyWorkspace(second)
  await reply(second, 'repo.show', { repo: { displayName: 'Second project' } })
  expect(live?.projectName).toBe('Second project')
  await act(async () => {
    late.resolve({ id: 'late-project', ok: true, result: { repo: { displayName: 'Old reply' } } })
  })
  expect(live).toMatchObject({
    name: 'master',
    projectName: 'Second project'
  })
})
