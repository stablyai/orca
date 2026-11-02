import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'
import { MOBILE_RPC_METHOD_ROUTES } from './runtime-rpc/runtime-rpc-mobile-method-routing'

it('admits host-owned automation operations and setup reads for phones without project writes', async () => {
  const path = mkdtempSync(join(tmpdir(), 'orca-mobile-automations-'))
  const { runtime } = createMobileRpcSurfaceRuntime()
  const owner = { selector: { kind: 'self' } }
  const update = vi.fn(() => ({ id: 'a' }))
  const run = vi.fn(() => ({ id: 'manual-run' }))
  Object.assign(runtime, {
    listAutomationsForScope: () => ({ automations: [], items: [] }),
    showAutomation: () => ({ id: 'a' }),
    automationOwnerPrecondition: () => owner,
    createAutomation: () => ({ id: 'a' }),
    updateAutomation: update,
    deleteAutomation: () => ({ id: 'a', removed: true }),
    runAutomationNow: run,
    listAutomationRunsPage: () => ({ runs: [], nextCursor: null }),
    enrichMissingRepoGitRemoteIdentities: () => {},
    listProjects: () => [],
    listVisibleProjectHostSetups: () => []
  })
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath: path, enableWebSocket: false })
  server['deviceRegistry'] = new DeviceRegistry(path)
  const phone = server['deviceRegistry'].addDevice('phone', 'mobile')
  const replies: unknown[] = []
  const requests = [
    { method: 'automation.list', params: {} },
    { method: 'automation.show', params: { id: 'a', expectedOwner: owner } },
    {
      method: 'automation.create',
      params: {
        name: 'Daily',
        prompt: 'Review',
        agentId: 'codex',
        rrule: '0 9 * * *',
        dtstart: 1,
        enabled: true
      }
    },
    {
      method: 'automation.update',
      params: { id: 'a', updates: { enabled: false }, expectedOwner: owner }
    },
    { method: 'automation.delete', params: { id: 'a', expectedOwner: owner } },
    { method: 'automation.runNow', params: { id: 'a', expectedOwner: owner } },
    { method: 'automation.runs', params: { limit: 30 } },
    { method: 'project.list', params: undefined },
    { method: 'projectHostSetup.list', params: undefined }
  ]
  try {
    for (const request of requests) {
      expect(MOBILE_RPC_METHOD_ROUTES.get(request.method)).toBe('execution-host')
      await server['handleWebSocketMessage'](
        JSON.stringify({ ...request, id: request.method, deviceToken: phone.token }),
        (response) => replies.push(JSON.parse(response)),
        () => {}
      )
      expect(replies.at(-1)).toMatchObject({ id: request.method, ok: true })
    }
    expect(update).toHaveBeenCalledWith(
      'a',
      { enabled: false },
      { expectedOwner: owner, destination: undefined }
    )
    expect(run).toHaveBeenCalledWith('a', owner)
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'write',
        method: 'project.update',
        deviceToken: phone.token,
        params: { projectId: 'p', updates: { displayName: 'Changed' } }
      }),
      (response) => replies.push(JSON.parse(response)),
      () => {}
    )
    expect(replies.at(-1)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
})
