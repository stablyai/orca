import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RuntimeTerminalListResult } from '../../../shared/runtime-terminal-contracts'
import type { RpcRequest, RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import { ALL_RPC_METHODS } from './methods'
import type { RpcCallerScope } from './rpc-caller-scope'
import { RPC_METHOD_PERMISSIONS } from './rpc-method-permission'
import { SSH_BRIDGE_HOST_BINDERS } from './ssh-bridge-host-binding'
import {
  CONTROL_GRANTED_SSH_BRIDGE_SCOPE as CONTROL_GRANTED,
  HOST_BOUND_SSH_BRIDGE_SCOPE as HOST_BOUND
} from '../../ssh/ssh-bridge-caller-scope.test-fixture'

const PAIRED: RpcCallerScope = { kind: 'runtime-paired', grants: [] }

function request(method: string, params?: unknown): RpcRequest {
  return { id: `req-${method}`, authToken: 'unused', method, params }
}

async function dispatchAs(
  scope: RpcCallerScope | undefined,
  method: string,
  params?: unknown,
  runtime = new OrcaRuntimeService()
): Promise<RpcResponse> {
  return new RpcDispatcher({ runtime }).dispatch(
    request(method, params),
    scope ? { callerScope: scope } : undefined
  )
}

async function dispatchStreamingAs(
  scope: RpcCallerScope,
  method: string,
  params?: unknown
): Promise<RpcResponse> {
  const replies: RpcResponse[] = []
  await new RpcDispatcher({ runtime: new OrcaRuntimeService() }).dispatchStreaming(
    request(method, params),
    (raw) => replies.push(JSON.parse(raw)),
    { callerScope: scope }
  )
  const [reply] = replies
  if (!reply) {
    throw new Error('no reply')
  }
  return reply
}

function errorCode(response: RpcResponse): string | null {
  return response.ok ? null : response.error.code
}

function terminalSummary(handle: string, executionHostId: 'ssh:box-1' | 'ssh:box-2' | 'local') {
  return {
    handle,
    ptyId: null,
    worktreeId: `wt-${handle}`,
    worktreePath: `/wt/${handle}`,
    branch: 'main',
    tabId: 'tab',
    leafId: 'leaf',
    title: null,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: `secret output of ${handle}`,
    executionHostId
  } as const
}

describe('every RPC method declares a known permission', () => {
  it('rejects nothing outside the permission vocabulary', () => {
    for (const method of ALL_RPC_METHODS) {
      expect(RPC_METHOD_PERMISSIONS, method.name).toContain(method.permission)
    }
  })

  it('classifies desktop control and owner administration as non-workspace', () => {
    const permissionOf = (name: string) => ALL_RPC_METHODS.find((m) => m.name === name)?.permission
    expect(permissionOf('computer.click')).toBe('desktop-control')
    expect(permissionOf('computer.typeText')).toBe('desktop-control')
    expect(permissionOf('computer.permissionsStatus')).toBe('workspace')
    expect(permissionOf('accounts.selectClaude')).toBe('accounts-admin')
    expect(permissionOf('settings.update')).toBe('settings-write')
    expect(permissionOf('skills.install')).toBe('skills-admin')
    expect(permissionOf('skills.share')).toBe('skills-admin')
    expect(permissionOf('pairing.provisionRelay')).toBe('pairing-admin')
    expect(permissionOf('ssh.connect')).toBe('host-admin')
    expect(permissionOf('network.browserTunnel')).toBe('host-admin')
  })
})

describe('SSH bridge without the per-host opt-in', () => {
  it('binds only registered workspace methods', () => {
    const permissionOf = (name: string) => ALL_RPC_METHODS.find((m) => m.name === name)?.permission
    for (const method of SSH_BRIDGE_HOST_BINDERS.keys()) {
      expect(permissionOf(method), method).toBe('workspace')
    }
  })

  it.each([
    ['computer.click', { app: 'Finder' }],
    ['accounts.selectClaude', {}],
    ['settings.update', {}],
    ['skills.install', {}],
    ['terminal.create', {}],
    ['orchestration.dispatch', { task: 'task_1' }],
    ['files.read', {}]
  ])('refuses %s before any handler runs', async (method, params) => {
    const response = await dispatchAs(HOST_BOUND, method, params)
    expect(errorCode(response)).toBe('forbidden')
  })

  it('enforces the same refusal on the streaming transport', async () => {
    const response = await dispatchStreamingAs(HOST_BOUND, 'computer.click', { app: 'Finder' })
    expect(errorCode(response)).toBe('forbidden')
  })

  it("refuses a terminal handle that resolves to another host's terminal", async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      ...terminalSummary('term_other', 'ssh:box-2'),
      paneRuntimeId: 1,
      rendererGraphEpoch: 0
    })
    const read = vi.spyOn(runtime, 'readTerminal')
    const response = await dispatchAs(
      HOST_BOUND,
      'terminal.read',
      { terminal: 'term_other' },
      runtime
    )
    expect(errorCode(response)).toBe('forbidden')
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses a terminal whose host cannot be named', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'showTerminal').mockRejectedValue(new Error('terminal_not_found'))
    const send = vi.spyOn(runtime, 'sendTerminal')
    const response = await dispatchAs(
      HOST_BOUND,
      'terminal.send',
      { terminal: 'term_unknown', text: 'rm -rf ~' },
      runtime
    )
    expect(errorCode(response)).toBe('forbidden')
    expect(send).not.toHaveBeenCalled()
  })

  it("reads the bridged host's own terminal", async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      ...terminalSummary('term_own', 'ssh:box-1'),
      paneRuntimeId: 1,
      rendererGraphEpoch: 0
    })
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: 'term_own',
      status: 'running',
      tail: ['ok'],
      truncated: false,
      nextCursor: null
    })
    const response = await dispatchAs(
      HOST_BOUND,
      'terminal.read',
      { terminal: 'term_own' },
      runtime
    )
    expect(response.ok).toBe(true)
  })

  it("lists only the bridged host's terminals", async () => {
    const runtime = new OrcaRuntimeService()
    const listing: RuntimeTerminalListResult = {
      terminals: [
        terminalSummary('term_own', 'ssh:box-1'),
        terminalSummary('term_local', 'local'),
        terminalSummary('term_other', 'ssh:box-2')
      ],
      totalCount: 3,
      truncated: false,
      topologyRevisions: { 'wt-term_own': 1, 'wt-term_local': 2 },
      hostScope: { hostIds: ['local', 'ssh:box-1', 'ssh:box-2'], omittedHostIds: [] }
    }
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue(listing)
    const response = await dispatchAs(HOST_BOUND, 'terminal.list', {}, runtime)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result).toEqual({
      terminals: [terminalSummary('term_own', 'ssh:box-1')],
      totalCount: 1,
      truncated: false,
      topologyRevisions: { 'wt-term_own': 1 },
      hostScope: { hostIds: ['ssh:box-1'], omittedHostIds: [] }
    })
  })

  it("refuses a terminal listing selected by another host's worktree", async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminalSummary('term_local', 'local')],
      totalCount: 1,
      truncated: false
    })
    const response = await dispatchAs(
      HOST_BOUND,
      'terminal.list',
      { worktree: 'path:/Users/me/secret' },
      runtime
    )
    expect(errorCode(response)).toBe('forbidden')
  })
})

describe('SSH bridge with the per-host opt-in', () => {
  it('reaches workspace methods outside its own host', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
      terminals: [terminalSummary('term_local', 'local')],
      totalCount: 1,
      truncated: false
    })
    const response = await dispatchAs(CONTROL_GRANTED, 'terminal.list', {}, runtime)
    expect(response.ok).toBe(true)
  })

  it.each([
    ['computer.click', { app: 'Finder' }],
    ['accounts.selectClaude', {}],
    ['settings.update', {}],
    ['skills.install', {}],
    ['ssh.connect', {}],
    ['pairing.provisionRelay', {}]
  ])('still refuses owner-only %s', async (method, params) => {
    const response = await dispatchAs(CONTROL_GRANTED, method, params)
    expect(errorCode(response)).toBe('forbidden')
  })
})

describe('paired runtime clients', () => {
  it('cannot drive the desktop without a pairing-time grant', async () => {
    const response = await dispatchAs(PAIRED, 'computer.click', { app: 'Finder' })
    expect(errorCode(response)).toBe('forbidden')
  })

  it('may drive the desktop when the pairing granted it', async () => {
    const response = await dispatchAs(
      { kind: 'runtime-paired', grants: ['desktop-control'] },
      'computer.click',
      {}
    )
    expect(errorCode(response)).not.toBe('forbidden')
  })

  it.each(['settings.update', 'accounts.selectClaude', 'skills.install', 'updater.check'])(
    'keep the remote UI surface: %s',
    async (method) => {
      const response = await dispatchAs(PAIRED, method, {})
      expect(errorCode(response)).not.toBe('forbidden')
    }
  )

  it.each(['pairing.provisionRelay', 'pairing.getEndpoints', 'notifications.registerPush'])(
    'are refused pairing and push administration: %s',
    async (method) => {
      const response = await dispatchAs(PAIRED, method, {})
      expect(errorCode(response)).toBe('forbidden')
    }
  )

  it('learn an unregistered method is missing rather than forbidden', async () => {
    const response = await dispatchAs(PAIRED, 'computer.methodFromTheFuture', {})
    expect(errorCode(response)).toBe('method_not_found')
  })
})

describe('the owner', () => {
  it('reaches desktop control unscoped', async () => {
    const response = await dispatchAs(undefined, 'computer.click', {})
    expect(errorCode(response)).not.toBe('forbidden')
  })
})

describe('a pinned in-process bridge dispatcher', () => {
  it('ignores a wider per-call scope', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: new OrcaRuntimeService(),
      callerScope: HOST_BOUND
    })
    const response = await dispatcher.dispatch(request('computer.click', { app: 'Finder' }), {
      callerScope: { kind: 'owner' }
    })
    expect(errorCode(response)).toBe('forbidden')
  })
})
