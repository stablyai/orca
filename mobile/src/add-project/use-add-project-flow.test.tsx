import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { AddProjectRpcSender } from './add-project-operations'
import type { RpcResponse } from '../transport/types'
import { useAddProjectFlow, type AddProjectFlow } from './use-add-project-flow'

type Handler = (params: unknown) => RpcResponse | Promise<RpcResponse>

function ok(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result }
}

function fail(message: string): RpcResponse {
  return { id: 'reply', ok: false, error: { code: 'error', message } }
}

function fakeClient(handlers: Record<string, Handler>) {
  const sendRequest = vi.fn(async (method: string, params?: unknown) => {
    const handler = handlers[method]
    return handler ? handler(params) : fail(`unexpected ${method}`)
  })
  const client: AddProjectRpcSender = { sendRequest }
  return { client, sendRequest }
}

const HOST_HANDLERS: Record<string, Handler> = {
  'files.browseServerDir': (params) => {
    const path =
      typeof params === 'object' && params !== null && 'path' in params ? String(params.path) : ''
    return ok({
      resolvedPath: path === '~' ? '/home/alice' : path.replace(/^~/, '/home/alice'),
      entries: []
    })
  },
  'repo.gitAvailable': () => ok({ available: true })
}

async function mountFlow(client: AddProjectRpcSender, onProjectAdded = vi.fn()) {
  const current: { flow: AddProjectFlow | null } = { flow: null }
  function Harness() {
    current.flow = useAddProjectFlow({ client, visible: true, onProjectAdded })
    return null
  }
  await act(async () => {
    create(createElement(Harness))
  })
  return { current, onProjectAdded }
}

describe('useAddProjectFlow', () => {
  it('registers an existing folder by the absolute path the host resolved', async () => {
    const repo = { id: 'r1', displayName: 'app', path: '/home/alice/code/app', kind: 'git' }
    const { client, sendRequest } = fakeClient({
      ...HOST_HANDLERS,
      'repo.add': () => ok({ repo })
    })
    const { current, onProjectAdded } = await mountFlow(client)

    await act(async () => current.flow!.setExistingPath('~/code/app'))
    await act(async () => current.flow!.submitExisting('git'))

    expect(sendRequest).toHaveBeenCalledWith('repo.add', {
      path: '/home/alice/code/app',
      kind: 'git'
    })
    expect(onProjectAdded).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }))
    expect(current.flow!.step).toBe('added')
  })

  it('creates under the default location expanded against the host home', async () => {
    const { client, sendRequest } = fakeClient({
      ...HOST_HANDLERS,
      'repo.create': () =>
        ok({ repo: { id: 'r2', displayName: 'demo', path: '/home/alice/orca/projects/demo' } })
    })
    const { current } = await mountFlow(client)

    await act(async () => current.flow!.setName('demo'))
    await act(async () => current.flow!.submitCreate())

    expect(sendRequest).toHaveBeenCalledWith('repo.create', {
      parentPath: '/home/alice/orca/projects',
      name: 'demo',
      kind: 'git'
    })
    expect(current.flow!.step).toBe('added')
  })

  it('shows repo.create’s accepted refusal instead of reporting a project', async () => {
    const { client } = fakeClient({
      ...HOST_HANDLERS,
      'repo.create': () => ok({ error: '"demo" already exists at this location and is not empty.' })
    })
    const { current, onProjectAdded } = await mountFlow(client)

    await act(async () => current.flow!.setName('demo'))
    await act(async () => current.flow!.submitCreate())

    expect(current.flow!.error).toBe('"demo" already exists at this location and is not empty.')
    expect(current.flow!.step).toBe('choose')
    expect(onProjectAdded).not.toHaveBeenCalled()
  })

  it('keeps the form and a running clone when a reconnect swaps the client', async () => {
    const repo = { id: 'r3', displayName: 'app', path: '/home/alice/orca/projects/app' }
    let finishClone: (reply: RpcResponse) => void = () => undefined
    const first = fakeClient({
      ...HOST_HANDLERS,
      'repo.clone': () =>
        new Promise<RpcResponse>((resolve) => {
          finishClone = resolve
        })
    })
    const second = fakeClient(HOST_HANDLERS)
    const current: { flow: AddProjectFlow | null } = { flow: null }
    function Harness({ client }: { client: AddProjectRpcSender }) {
      current.flow = useAddProjectFlow({ client, visible: true, onProjectAdded: vi.fn() })
      return null
    }
    let root: ReturnType<typeof create> | null = null
    await act(async () => {
      root = create(createElement(Harness, { client: first.client }))
    })

    await act(async () => current.flow!.openStep('clone'))
    await act(async () => current.flow!.setUrl('https://example.com/app.git'))
    let cloning: Promise<void> = Promise.resolve()
    await act(async () => {
      cloning = current.flow!.submitClone()
    })
    await act(async () => root!.update(createElement(Harness, { client: second.client })))

    expect(current.flow!.step).toBe('clone')
    expect(current.flow!.url).toBe('https://example.com/app.git')
    expect(current.flow!.busy).toBe(true)

    await act(async () => {
      finishClone(ok({ repo }))
      await cloning
    })
    expect(current.flow!.step).toBe('added')
  })
})
