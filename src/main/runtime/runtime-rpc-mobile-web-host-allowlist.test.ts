import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'
import { ALL_RPC_METHODS } from './rpc/methods'
import {
  MOBILE_WEB_HOST_RPC_CANCEL_METHODS,
  MOBILE_WEB_HOST_RPC_METHODS
} from './rpc/methods/mobile-web-host-rpc-allowlist'

it('admits every allowlisted method and cancel through authenticated mobile dispatch', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-host-allowlist-'))
  const { runtime } = createMobileRpcSurfaceRuntime()
  const readMobileFile = vi.fn().mockResolvedValue({
    worktree: 'private-workspace',
    rootPath: '/private/repo',
    relativePath: 'README.md',
    content: 'host-owned adapter',
    byteLength: 18,
    truncated: false,
    futureField: { revision: 2 }
  })
  const setMobileAutoRestoreFitMs = vi.fn((ms: number | null) => ms)
  Object.assign(runtime, {
    readMobileFile,
    getMobileAutoRestoreFitMs: () => 2500,
    setMobileAutoRestoreFitMs
  })
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  const mobile = server['deviceRegistry']!.addDevice('phone', 'mobile')
  async function dispatch(method: string, params: unknown = {}) {
    const responses: { ok: boolean; result?: unknown; error?: { code: string } }[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'request', method, params, deviceToken: mobile.token }),
      (response) => responses.push(JSON.parse(response)),
      () => {}
    )
    expect(responses).toHaveLength(1)
    return responses[0]!
  }
  try {
    const registered = new Set(ALL_RPC_METHODS.map((method) => method.name))
    for (const method of [...MOBILE_WEB_HOST_RPC_METHODS, ...MOBILE_WEB_HOST_RPC_CANCEL_METHODS]) {
      expect(registered.has(method), method).toBe(true)
      // Invalid parameters stop at validation; this verifies the real authorization boundary.
      const response = await dispatch(method, null)
      expect(response.error?.code, method).not.toBe('forbidden')
      expect(response.error?.code, method).not.toBe('method_not_found')
    }
    expect(MOBILE_WEB_HOST_RPC_CANCEL_METHODS).toEqual(
      new Set([
        'accounts.unsubscribe',
        'mobileWeb.browser.unsubscribe',
        'mobileWeb.files.unwatch',
        'mobileWeb.nativeChat.unsubscribe',
        'mobileWeb.session.unsubscribe',
        'mobileWeb.workspace.unsubscribe'
      ])
    )
    await expect(
      dispatch('mobileWeb.files.read', {
        worktree: 'id:workspace',
        relativePath: 'README.md'
      })
    ).resolves.toMatchObject({
      ok: true,
      result: {
        relativePath: 'README.md',
        content: 'host-owned adapter',
        byteLength: 18,
        truncated: false,
        futureField: { revision: 2 }
      }
    })
    expect(readMobileFile).toHaveBeenCalledWith('id:workspace', 'README.md')
    const result = await dispatch('mobileWeb.files.read', {
      worktree: 'id:workspace',
      relativePath: 'README.md'
    })
    expect(JSON.stringify(result.result)).not.toContain('private')
    await expect(dispatch('terminal.getAutoRestoreFit', {})).resolves.toMatchObject({
      ok: true,
      result: { ms: 2500 }
    })
    await expect(dispatch('terminal.setAutoRestoreFit', { ms: null })).resolves.toMatchObject({
      ok: true,
      result: { ms: null }
    })
    expect(setMobileAutoRestoreFitMs).toHaveBeenCalledWith(null)
    await expect(dispatch('files.delete')).resolves.toMatchObject({ error: { code: 'forbidden' } })
    await expect(dispatch('mobileWeb.futureUnadvertised')).resolves.toMatchObject({
      error: { code: 'forbidden' }
    })
  } finally {
    await server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
