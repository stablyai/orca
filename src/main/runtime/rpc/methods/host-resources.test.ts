import os from 'node:os'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_RESOURCES_RUNTIME_CAPABILITY } from '../../../../shared/host-resources'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { MOBILE_RPC_METHOD_ROUTES } from '../../runtime-rpc/runtime-rpc-mobile-method-routing'
import { HOST_RESOURCES_METHODS } from './host-resources'

const { collectHostResources } = vi.hoisted(() => ({
  collectHostResources: vi.fn()
}))

vi.mock('../../../memory/host-resources', () => ({
  collectHostResources
}))

const hostResources = HOST_RESOURCES_METHODS[0]

describe('host.resources', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    collectHostResources.mockReset()
    collectHostResources.mockResolvedValue({ sampledAt: 1 })
  })

  it('is a workspace read and not a stream', () => {
    expect(hostResources).toBeDefined()
    expect(hostResources?.name).toBe('host.resources')
    expect(hostResources?.permission).toBe('workspace')
    expect(hostResources && 'stream' in hostResources).toBe(false)
  })

  it('passes the home directory and each repo path to the collector', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/tester')
    const listRepos = vi.fn(() => [{ path: '/work/a' }, { path: '/work/b' }])
    // SAFETY: host.resources only reads listRepos().path.
    const runtime = { listRepos } as unknown as OrcaRuntimeService
    if (!hostResources) {
      throw new Error('missing host.resources')
    }

    await expect(hostResources.handler(undefined, { runtime })).resolves.toEqual({ sampledAt: 1 })

    expect(collectHostResources).toHaveBeenCalledWith([
      { role: 'home', path: '/home/tester' },
      { role: 'workspace', path: '/work/a' },
      { role: 'workspace', path: '/work/b' }
    ])
  })

  it('runs on the execution host, not the relaying desktop', () => {
    expect(MOBILE_RPC_METHOD_ROUTES.get('host.resources')).toBe('execution-host')
  })

  it('advertises the host resources runtime capability', () => {
    expect(RUNTIME_CAPABILITIES).toContain(HOST_RESOURCES_RUNTIME_CAPABILITY)
  })
})
