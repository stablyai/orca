import { describe, expect, it, vi } from 'vitest'
import { TerminalCreateParams } from '../../shared/rpc-contract/terminal-unary-params'
import type { OrchestrationEnvironmentTransport } from './orchestration/environment-transport'
import { forwardTerminalCreate } from './terminal-create-host-forwarding'

const setup = {
  id: 'setup',
  projectId: 'project',
  hostId: 'local',
  setupState: 'ready',
  path: 'C:\\project'
}
const terminal = {
  handle: 'real handle',
  worktreeId: 'remote-worktree',
  title: null,
  tabId: 'host-tab'
}
const request = TerminalCreateParams.parse({
  worktree: 'id:local-worktree',
  executionHostId: 'runtime:E',
  projectHostSetupId: 'setup',
  tabId: 'client-tab',
  leafId: 'client-leaf',
  clientMutationId: 'client-mutation',
  reconcileExisting: true,
  focus: true,
  activate: true,
  presentation: 'focused',
  rendererBacked: true,
  command: 'pwd'
})
const resolveWorkspace = async () => ({ managedWorktree: { projectId: 'project' } })

function fixture(rows: unknown[] = [setup]) {
  const call = vi.fn<OrchestrationEnvironmentTransport['call']>(async (_host, method) => ({
    id: 'reply',
    ok: true,
    result: method === 'projectHostSetup.list' ? { setups: rows } : { terminal },
    _meta: { runtimeId: 'ephemeral-runtime' }
  }))
  const transport = {
    call,
    resolve: () => ({
      environmentId: 'E',
      pairingRevision: 7,
      name: 'Server',
      peerFingerprint: 'peer'
    })
  }
  return {
    call,
    transport,
    create: () => forwardTerminalCreate(request, { resolveWorkspace, transport })
  }
}

describe('host terminal forwarding contract', () => {
  it('uses the selected endpoint and its exact setup path, with the pairing pinned', async () => {
    const { call, create } = fixture()
    expect(await create()).toMatchObject({
      ...terminal,
      executionHostId: 'runtime:E',
      ptyId: 'remote:E@@real%20handle'
    })
    expect(call.mock.calls.map(([host, method]) => [host, method])).toEqual([
      ['E', 'projectHostSetup.list'],
      ['E', 'terminal.create']
    ])
    expect(call.mock.calls.every((args) => args[5] === 7)).toBe(true)
    const payload = call.mock.calls[1]?.[2]
    expect(payload).toMatchObject({
      worktree: 'path:C:\\project',
      command: 'pwd',
      focus: false,
      activate: false,
      presentation: 'background'
    })
    expect(payload).toEqual(TerminalCreateParams.parse(payload))
    for (const key of [
      'executionHostId',
      'projectHostSetupId',
      'clientMutationId',
      'reconcileExisting',
      'tabId',
      'leafId',
      'spawnIntent',
      'rendererBacked'
    ]) {
      expect(payload).not.toHaveProperty(key)
    }
  })

  it.each([
    {},
    { id: 'other-setup' },
    { projectId: 'other' },
    { setupState: 'setting-up' },
    { path: '  ' },
    { hostId: 'runtime:other' },
    { hostId: 'ssh:nested' },
    { executionHostId: 'ssh:nested' },
    { connectionId: 'nested' }
  ])('refuses an unknown, mismatched or unusable setup %j', async (change) => {
    const { call, transport } = fixture(Object.keys(change).length ? [{ ...setup, ...change }] : [])
    await expect(
      forwardTerminalCreate(request, { resolveWorkspace, transport })
    ).rejects.toMatchObject({
      code: 'project_not_set_up_on_host',
      data: { executionHostId: 'runtime:E', projectHostSetupId: 'setup', projectId: 'project' }
    })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('accepts the selected-runtime spelling of the same endpoint owner', async () => {
    await expect(fixture([{ ...setup, hostId: 'runtime:E' }]).create()).resolves.toHaveProperty(
      'handle',
      terminal.handle
    )
  })

  it('refuses folder workspaces without a durable project identity', async () => {
    const { call, transport } = fixture()
    await expect(
      forwardTerminalCreate(request, {
        resolveWorkspace: async () => ({ managedWorktree: null }),
        transport
      })
    ).rejects.toHaveProperty('code', 'project_not_set_up_on_host')
    expect(call).not.toHaveBeenCalled()
  })

  it('refuses relay-era SSH and missing callers without creating locally', async () => {
    const { call, transport } = fixture()
    await expect(
      forwardTerminalCreate(
        { ...request, executionHostId: 'ssh:target' },
        { resolveWorkspace, transport }
      )
    ).rejects.toHaveProperty('code', 'host_kind_not_supported_yet')
    await expect(
      forwardTerminalCreate(request, { resolveWorkspace, transport: null })
    ).rejects.toHaveProperty('code', 'host_kind_not_supported_yet')
    expect(call).not.toHaveBeenCalled()
  })

  it.each(['projectHostSetup.list', 'terminal.create'])(
    'preserves %s refusal data without inventing a handle',
    async (method) => {
      const { call, create } = fixture()
      if (method === 'terminal.create') {
        call.mockResolvedValueOnce({
          id: 'reply',
          ok: true,
          result: { setups: [setup] },
          _meta: { runtimeId: 'host' }
        })
      }
      call.mockResolvedValueOnce({
        id: 'refusal',
        ok: false,
        error: { code: 'project_not_set_up_on_host', message: 'Not ready', data: { retry: false } }
      })
      await expect(create()).rejects.toMatchObject({
        code: 'project_not_set_up_on_host',
        message: 'Not ready',
        data: { retry: false }
      })
      expect(call).toHaveBeenCalledTimes(method === 'terminal.create' ? 2 : 1)
    }
  )

  it('refuses a missing or substituted environment before any remote call', async () => {
    const { call, transport } = fixture()
    for (const resolve of [
      () => {
        throw new Error('Unknown environment')
      },
      () => ({ ...transport.resolve(), environmentId: 'other' })
    ]) {
      await expect(
        forwardTerminalCreate(request, { resolveWorkspace, transport: { ...transport, resolve } })
      ).rejects.toHaveProperty('code', 'host_kind_not_supported_yet')
    }
    expect(call).not.toHaveBeenCalled()
  })

  it.each(['runtime:', 'ssh:%zz', 'ephemeral-runtime-id'])(
    'rejects invalid host encoding %s at the RPC boundary',
    (executionHostId) => {
      expect(TerminalCreateParams.safeParse({ ...request, executionHostId }).success).toBe(false)
    }
  )

  it('rejects malformed catalog and create replies', async () => {
    const { call, create } = fixture()
    call.mockResolvedValueOnce({
      id: 'reply',
      ok: true,
      result: { setups: null },
      _meta: { runtimeId: 'host' }
    })
    await expect(create()).rejects.toHaveProperty('code', 'invalid_runtime_response')
    call.mockResolvedValueOnce({
      id: 'reply',
      ok: true,
      result: { setups: [setup] },
      _meta: { runtimeId: 'host' }
    })
    call.mockResolvedValueOnce({
      id: 'reply',
      ok: true,
      result: { terminal: { title: null } },
      _meta: { runtimeId: 'host' }
    })
    await expect(create()).rejects.toHaveProperty('code', 'invalid_runtime_response')
    expect(call).toHaveBeenCalledTimes(3)
  })

  it.each(['closed', 'refused', 'disconnected'])(
    'closes a recoverable malformed create on the same endpoint even when cleanup is %s',
    async (cleanup) => {
      const { call, create } = fixture()
      call.mockResolvedValueOnce({
        id: 'catalog',
        ok: true,
        result: { setups: [setup] },
        _meta: { runtimeId: 'host' }
      })
      call.mockResolvedValueOnce({
        id: 'created',
        ok: true,
        result: {
          terminal: {
            handle: 'recoverable',
            incarnationId: 'created-incarnation',
            agentSessionDisposition: 'created'
          }
        },
        _meta: { runtimeId: 'host' }
      })
      if (cleanup === 'disconnected') {
        call.mockRejectedValueOnce(new Error('Connection lost during close'))
      } else if (cleanup === 'refused') {
        call.mockResolvedValueOnce({
          id: 'close',
          ok: false,
          error: { code: 'terminal_gone', message: 'Already gone' }
        })
      } else {
        call.mockResolvedValueOnce({
          id: 'close',
          ok: true,
          result: { close: {} },
          _meta: { runtimeId: 'host' }
        })
      }
      await expect(create()).rejects.toHaveProperty('code', 'invalid_runtime_response')
      expect(call.mock.calls.map(([host, method]) => [host, method])).toEqual([
        ['E', 'projectHostSetup.list'],
        ['E', 'terminal.create'],
        ['E', 'terminal.close']
      ])
      expect(call.mock.calls[2]).toEqual([
        'E',
        'terminal.close',
        { terminal: 'recoverable', expectedIncarnationId: 'created-incarnation' },
        15_000,
        undefined,
        7
      ])
    }
  )

  it.each([
    { agentSessionDisposition: 'adopted' },
    { isReattach: true },
    { agentSessionDisposition: 'created', isReattach: true }
  ])('never closes a malformed reply for a pre-existing terminal %j', async (ownership) => {
    const { call, create } = fixture()
    const replyTerminal = { handle: 'pre-existing', incarnationId: 'existing', ...ownership }
    call.mockResolvedValueOnce({
      id: 'catalog',
      ok: true,
      result: { setups: [setup] },
      _meta: { runtimeId: 'host' }
    })
    call.mockResolvedValueOnce({
      id: 'created',
      ok: true,
      result: { terminal: replyTerminal },
      _meta: { runtimeId: 'host' }
    })
    const failure = create()
    await expect(failure).rejects.toHaveProperty('code', 'invalid_runtime_response')
    expect(call.mock.calls.map(([host, method]) => [host, method])).toEqual([
      ['E', 'projectHostSetup.list'],
      ['E', 'terminal.create']
    ])
    await expect(failure).rejects.toMatchObject({
      data: {
        executionHostId: 'runtime:E',
        projectHostSetupId: 'setup',
        projectId: 'project',
        terminal: replyTerminal
      }
    })
  })

  it.each([undefined, null, ''])(
    'omits an absent or unusable incarnation from the cleanup wire payload: %j',
    async (incarnationId) => {
      const { call, create } = fixture()
      call.mockResolvedValueOnce({
        id: 'catalog',
        ok: true,
        result: { setups: [setup] },
        _meta: { runtimeId: 'host' }
      })
      call.mockResolvedValueOnce({
        id: 'created',
        ok: true,
        result: { terminal: { handle: 'recoverable', incarnationId } },
        _meta: { runtimeId: 'host' }
      })
      await expect(create()).rejects.toHaveProperty('code', 'invalid_runtime_response')
      expect(call).toHaveBeenCalledTimes(3)
      expect(call.mock.calls[2]).toEqual([
        'E',
        'terminal.close',
        { terminal: 'recoverable' },
        15_000,
        undefined,
        7
      ])
    }
  )

  it('omits the remote process id from a valid local result', async () => {
    const { call, create } = fixture()
    call.mockResolvedValueOnce({
      id: 'catalog',
      ok: true,
      result: { setups: [setup] },
      _meta: { runtimeId: 'host' }
    })
    call.mockResolvedValueOnce({
      id: 'created',
      ok: true,
      result: { terminal: { ...terminal, processId: 1234 } },
      _meta: { runtimeId: 'host' }
    })
    expect(await create()).not.toHaveProperty('processId')
  })

  it('does not retry or guess a handle after a create timeout', async () => {
    const { call, create } = fixture()
    call.mockResolvedValueOnce({
      id: 'catalog',
      ok: true,
      result: { setups: [setup] },
      _meta: { runtimeId: 'host' }
    })
    const timeout = Object.assign(new Error('Create timed out'), { code: 'runtime_timeout' })
    call.mockRejectedValueOnce(timeout)
    await expect(create()).rejects.toBe(timeout)
    expect(call).toHaveBeenCalledTimes(2)
  })
})
