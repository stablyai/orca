import { describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../../shared/plugins/capabilities/plugin-capabilities'
import { PluginRuntimeRpcError } from '../../plugin-runtime-rpc'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'

const REPOS = {
  repos: [
    { id: 'r1', displayName: 'App', path: '/src/app', executionHostId: 'local' },
    { id: 'gone', displayName: 'Old', path: '/src/old', executionHostId: 'local', hiddenAt: 5 },
    { id: 'twin', displayName: 'Twin', path: '/l/twin', executionHostId: 'local' },
    { id: 'twin', displayName: 'Twin', path: '/r/twin', connectionId: 'box', hiddenAt: 'x' }
  ]
}

function runtime(answers: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    'repo.list': REPOS,
    'repo.setHidden': (params: { repoHostId: string; hidden: boolean }) => ({
      repo: {},
      hostId: params.repoHostId,
      hidden: params.hidden
    }),
    ...answers
  }
  return vi.fn<PluginRuntimeRpc>(async (method, params) => {
    const answer = all[method]
    if (answer instanceof Error) {
      throw answer
    }
    return typeof answer === 'function' ? answer(params) : answer
  })
}

const call = (
  method: string,
  params: unknown,
  rpc: PluginRuntimeRpc,
  granted: PluginCapabilityKind[] = ['workspace:write', 'workspace:read'],
  audit = { record: vi.fn().mockResolvedValue(undefined) }
) => callPluginHost({ method, params, granted, services: pluginHostTestServices(rpc), audit })

const setHiddenParams = (rpc: ReturnType<typeof runtime>) =>
  rpc.mock.calls.filter(([name]) => name === 'repo.setHidden').map(([, params]) => params)

describe('project.setHidden', () => {
  it("hides one host's copy by id, host-qualified even when the plugin names no host", async () => {
    const rpc = runtime()
    const audit = { record: vi.fn().mockResolvedValue(undefined) }
    expect(
      await call('project.setHidden', { projectId: 'r1', hidden: true }, rpc, undefined, audit)
    ).toEqual({ ok: true, value: { hostId: 'local', hidden: true } })
    expect(
      await call('project.setHidden', { projectId: 'twin', hostId: 'ssh:box', hidden: false }, rpc)
    ).toEqual({ ok: true, value: { hostId: 'ssh:box', hidden: false } })
    expect(setHiddenParams(rpc)).toEqual([
      { repo: 'id:r1', repoHostId: 'local', hidden: true },
      { repo: 'id:twin', repoHostId: 'ssh:box', hidden: false }
    ])
    // Ids only: no project name or path reaches the audit log.
    expect(JSON.stringify(audit.record.mock.calls)).toContain('project=r1 host=any hidden=true')
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain('/src/app')
  })

  it('refuses an unknown project, or a twin without hostId, before changing anything', async () => {
    const rpc = runtime()
    const outcomes = await Promise.all([
      call('project.setHidden', { projectId: 'twin', hidden: true }, rpc),
      call('project.setHidden', { projectId: 'nope', hidden: true }, rpc),
      call('project.setHidden', { projectId: 'r1', hostId: 'ssh:box', hidden: true }, rpc)
    ])
    expect(outcomes).toEqual([
      {
        ok: false,
        code: 'action_failed',
        error: 'two hosts have this project; pass the hostId project.list gives'
      },
      { ok: false, code: 'action_failed', error: 'no project has this id' },
      { ok: false, code: 'action_failed', error: 'no project has this id' }
    ])
    expect(setHiddenParams(rpc)).toEqual([])
  })

  it('needs workspace:write and takes no name or path selector', async () => {
    const rpc = runtime()
    expect(
      await call('project.setHidden', { projectId: 'r1', hidden: true }, rpc, ['workspace:read'])
    ).toMatchObject({ ok: false, code: 'capability_denied' })
    expect(
      await call('project.setHidden', { projectId: 'r1', path: '/src/app', hidden: true }, rpc)
    ).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(await call('project.setHidden', { projectId: 'r1' }, rpc)).toMatchObject({
      ok: false,
      code: 'invalid_params'
    })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('maps runtime refusals and a host that drops the field to fixed messages', async () => {
    const removed = runtime({
      'repo.setHidden': new PluginRuntimeRpcError('runtime_error', 'repo_not_found')
    })
    const older = runtime({ 'repo.setHidden': { repo: {} } })
    const disconnected = runtime({
      'repo.setHidden': new PluginRuntimeRpcError('runtime_unavailable', 'ssh box offline at /x')
    })
    expect(
      await Promise.all(
        [removed, older, disconnected].map((rpc) =>
          call('project.setHidden', { projectId: 'r1', hidden: true }, rpc)
        )
      )
    ).toEqual([
      { ok: false, code: 'action_failed', error: 'no project has this id' },
      {
        ok: false,
        code: 'action_failed',
        error: "this project's host could not change it; it may need an Orca update"
      },
      {
        ok: false,
        code: 'unavailable',
        error: 'this Orca host cannot run workspace actions now'
      }
    ])
  })
})

describe('project.list', () => {
  it('marks hidden copies, reading a malformed hiddenAt as shown', async () => {
    const outcome = await call('project.list', undefined, runtime())
    expect(outcome.ok && outcome.value).toMatchObject({
      projects: [
        { id: 'r1', hostId: 'local', hidden: false },
        { id: 'gone', hostId: 'local', hidden: true },
        { id: 'twin', hostId: 'local', hidden: false },
        { id: 'twin', hostId: 'ssh:box', hidden: false }
      ],
      truncated: false
    })
  })
})
