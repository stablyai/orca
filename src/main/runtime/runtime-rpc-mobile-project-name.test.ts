import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'

it.each(['local', 'ssh:build-host'])(
  'lets a paired phone read its session project name on %s',
  async (repoHostId) => {
    const path = mkdtempSync(join(tmpdir(), 'orca-mobile-project-name-'))
    const { runtime } = createMobileRpcSurfaceRuntime()
    const showRepo = vi.fn(() => ({
      id: 'repo-1',
      displayName: 'orca',
      externalWorktreeVisibility: 'hide'
    }))
    Object.assign(runtime, { showRepo })
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath: path, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(path)
    const phone = server['deviceRegistry'].addDevice('phone', 'mobile')
    const replies: unknown[] = []
    try {
      await server['handleWebSocketMessage'](
        JSON.stringify({
          id: 'project-name',
          method: 'repo.show',
          deviceToken: phone.token,
          params: { repo: 'id:repo-1', repoHostId }
        }),
        (response) => replies.push(JSON.parse(response)),
        () => {}
      )
      expect(replies).toEqual([
        expect.objectContaining({
          id: 'project-name',
          ok: true,
          result: { repo: expect.objectContaining({ displayName: 'orca' }) }
        })
      ])
      expect(showRepo).toHaveBeenCalledWith({ selector: 'id:repo-1', hostId: repoHostId })
    } finally {
      rmSync(path, { recursive: true, force: true })
    }
  }
)
