import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { RpcRequest, RpcResponse } from './core'
import { RpcDispatcher } from './dispatcher'
import { ALL_RPC_METHODS } from './methods'
import type { RpcCallerScope } from './rpc-caller-scope'
import { RPC_METHOD_PERMISSIONS } from './rpc-method-permission'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../runtime-rpc/runtime-rpc-mobile-method-allowlist'

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

function errorCode(response: RpcResponse): string | null {
  return response.ok ? null : response.error.code
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
    expect(permissionOf('settings.getAgentLaunch')).toBe('workspace')
    expect(permissionOf('settings.mutateAgentLaunch')).toBe('settings-write')
    expect(permissionOf('skills.install')).toBe('skills-admin')
    expect(permissionOf('skills.share')).toBe('skills-admin')
    expect(permissionOf('pairing.provisionRelay')).toBe('pairing-admin')
    expect(permissionOf('ssh.connect')).toBe('host-admin')
    expect(permissionOf('network.browserTunnel')).toBe('host-admin')
  })

  // Why: hosts open any absolute path for these callers, which is safe only because terminal access already reaches it.
  it.each([
    'files.resolveTerminalPath',
    'files.readTerminalArtifact',
    'files.readTerminalArtifactPreview',
    'files.writeTerminalArtifact'
  ])('gates %s exactly like opening a terminal', (name) => {
    const permissionOf = (method: string) =>
      ALL_RPC_METHODS.find((m) => m.name === method)?.permission
    expect(permissionOf(name)).toBe(permissionOf('terminal.create'))
    expect(MOBILE_RPC_METHOD_ALLOWLIST.has(name)).toBe(
      MOBILE_RPC_METHOD_ALLOWLIST.has('terminal.create')
    )
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
      callerScope: PAIRED
    })
    const response = await dispatcher.dispatch(request('computer.click', { app: 'Finder' }), {
      callerScope: { kind: 'owner' }
    })
    expect(errorCode(response)).toBe('forbidden')
  })
})
