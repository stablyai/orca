import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import { HOSTED_SANDBOX_SSH_PUBLIC_KEY } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import { EnvironmentProviderError } from '../environment-providers/environment-provider-driver'
import { environmentRecipeResult } from '../environment-providers/environment-provider-recipe-adapter'
import type { HostedSandboxControlPlaneClient } from '../hosted-sandbox/hosted-sandbox-control-plane-client'
import { HOSTED_SANDBOX_DRIVER_ID } from '../hosted-sandbox/hosted-sandbox-driver'
import { createCloudSshService, type CloudSshServiceDeps } from './cloud-ssh-service'

const HOST_KEY = `ssh-ed25519 ${'H'.repeat(68)}`

function cloudRuntime(overrides: Partial<EphemeralVmRuntimeRecord> = {}): EphemeralVmRuntimeRecord {
  return {
    id: 'evm-1',
    recipeId: 'cloud',
    recipe: {
      id: 'cloud',
      name: 'Orca Cloud',
      create: 'orca-cloud create',
      provider: 'orca-cloud'
    },
    workspaceId: 'repo::/ws/fix-login',
    workspaceName: 'Fix login bug',
    runtimeEnvironmentId: 'env-1',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: environmentRecipeResult(
      {
        driverId: HOSTED_SANDBOX_DRIVER_ID,
        environmentId: 'sbx_04af41afa508453a12018d01',
        driverState: { sandboxId: 'sbx_04af41afa508453a12018d01' }
      },
      { pairingCode: 'orca://pair?code=x', projectRoot: '/vercel/sandbox/project' },
      'orca-worktree'
    ),
    ...overrides
  }
}

let userDataPath: string
let runtimes: EphemeralVmRuntimeRecord[]
let installed: string[]
let calls: string[]
let control: HostedSandboxControlPlaneClient

function deps(overrides: Partial<CloudSshServiceDeps> = {}): CloudSshServiceDeps {
  return {
    userDataPath,
    deviceName: 'Test Mac',
    listRuntimes: () => runtimes,
    controlPlane: () => control,
    wake: async (id) => {
      calls.push(`wake:${id}`)
    },
    openForward: async (id) => {
      calls.push(`forward:${id}`)
      return { ok: true, localPort: 51234 }
    },
    cliCommand: () => '/Applications/Orca.app/Contents/Resources/bin/orca',
    now: () => 1000,
    ...overrides
  }
}

beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'orca-cloud-ssh-svc-'))
  runtimes = [cloudRuntime()]
  installed = []
  calls = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service calls only these two methods.
  control = {
    installSshKey: vi.fn(async (sandboxId: string, key: string) => {
      calls.push(`install:${sandboxId}`)
      installed = [...installed.filter((k) => k !== key), key]
      return { port: 2222, user: 'vercel-sandbox', hostKey: HOST_KEY }
    }),
    removeSshKey: vi.fn(async (sandboxId: string, key: string) => {
      calls.push(`remove:${sandboxId}`)
      installed = installed.filter((k) => k !== key)
      return { port: 2222, user: 'vercel-sandbox', hostKey: HOST_KEY }
    })
  } as unknown as HostedSandboxControlPlaneClient
})

afterEach(() => {
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('cloud ssh service', () => {
  it('first use: wakes, makes a private key, installs it and writes a pinned config', async () => {
    const service = createCloudSshService(deps())
    const access = await service.prepare('Fix login bug')
    expect(access.alias).toBe('orca-fix-login-bug-8d01')
    expect(access.projectRoot).toBe('/vercel/sandbox/project')
    expect(calls).toEqual(['wake:env-1', 'install:sbx_04af41afa508453a12018d01'])
    expect(installed).toHaveLength(1)
    expect(installed[0]).toMatch(HOSTED_SANDBOX_SSH_PUBLIC_KEY)
    expect(installed[0]).toContain(' orca:test-mac:orca-fix-login-bug-8d01')

    const keyFile = join(userDataPath, 'cloud-ssh', 'keys', access.alias)
    expect(statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(statSync(join(userDataPath, 'cloud-ssh')).mode & 0o777).toBe(0o700)
    const config = readFileSync(access.configFile, 'utf8')
    expect(config).toContain(`Host ${access.alias}`)
    expect(config).toContain('ssh-proxy evm-1')
    expect(readFileSync(join(userDataPath, 'cloud-ssh', 'known_hosts'), 'utf8')).toBe(
      `${access.alias} ${HOST_KEY}\n`
    )
    expect(access.command).toBe(`ssh -F ${access.configFile} ${access.alias}`)
  })

  it('copying again for a sleeping workspace that has access neither wakes nor reinstalls', async () => {
    const service = createCloudSshService(deps())
    await service.prepare('evm-1')
    calls = []
    await service.prepare('orca-fix-login-bug-8d01')
    expect(calls).toEqual([])
  })

  it('reinstalls once per VM boot, so a wiped disk or new host key heals on the next connect', async () => {
    const service = createCloudSshService(deps())
    await service.tunnel('evm-1')
    runtimes = [cloudRuntime({ updatedAt: 2 })]
    control.installSshKey = vi.fn(async () => ({
      port: 2222,
      user: 'vercel-sandbox',
      hostKey: `ssh-ed25519 ${'N'.repeat(68)}`
    }))
    await service.tunnel('evm-1')
    expect(control.installSshKey).toHaveBeenCalledTimes(1)
    expect(readFileSync(join(userDataPath, 'cloud-ssh', 'known_hosts'), 'utf8')).toContain(
      'N'.repeat(68)
    )
  })

  it('ssh-proxy always wakes, installs only once, then opens the forward', async () => {
    const service = createCloudSshService(deps())
    expect(await service.tunnel('evm-1')).toEqual({ port: 51234, runtimeEnvironmentId: 'env-1' })
    await service.tunnel('evm-1')
    expect(calls).toEqual([
      'wake:env-1',
      'install:sbx_04af41afa508453a12018d01',
      'forward:env-1',
      'wake:env-1',
      'forward:env-1'
    ])
  })

  it('reports a failed forward instead of hanging ssh', async () => {
    const service = createCloudSshService(
      deps({ openForward: async () => ({ ok: false, code: 'tunnel_failed', message: 'down' }) })
    )
    await expect(service.tunnel('evm-1')).rejects.toMatchObject({ code: 'forward_failed' })
  })

  it('says why: other VMs, unknown names, images without sshd, failed wakes', async () => {
    runtimes.push(cloudRuntime({ id: 'evm-2', workspaceId: 'repo::/ws/other', recipe: undefined }))
    const service = createCloudSshService(deps())
    await expect(service.prepare('repo::/ws/other')).rejects.toMatchObject({ code: 'not_cloud' })
    await expect(service.prepare('nope')).rejects.toMatchObject({ code: 'not_found' })

    control.installSshKey = vi.fn(async () => {
      throw new EnvironmentProviderError('conflict', 'x', 'ssh_unsupported_image')
    })
    await expect(service.prepare('evm-1')).rejects.toMatchObject({ code: 'unsupported_image' })

    const sleepy = createCloudSshService(
      deps({
        wake: async () => {
          throw new Error("This workspace's VM is waking up. Try again in a moment.")
        }
      })
    )
    await expect(sleepy.tunnel('evm-1')).rejects.toMatchObject({ code: 'wake_failed' })
  })

  it('revoke removes the key from the VM and deletes it here', async () => {
    const service = createCloudSshService(deps())
    const { alias } = await service.prepare('evm-1')
    expect(await service.revoke('repo::/ws/fix-login')).toEqual({ removedFromWorkspace: true })
    expect(installed).toEqual([])
    expect(existsSync(join(userDataPath, 'cloud-ssh', 'keys', alias))).toBe(false)
    expect(readFileSync(join(userDataPath, 'cloud-ssh', 'config'), 'utf8')).not.toContain(alias)
    expect((await service.status('repo::/ws/fix-login')).hasAccess).toBe(false)
  })

  it('revoke wakes the VM; one it cannot reach still loses the key here', async () => {
    let reachable = true
    const service = createCloudSshService(
      deps({
        wake: async (id) => {
          calls.push(`wake:${id}`)
          if (!reachable) {
            throw new Error('waking')
          }
        }
      })
    )
    const { alias } = await service.prepare('evm-1')
    calls = []
    reachable = false
    const revokedKey = installed[0]!
    expect(await service.revoke('evm-1')).toEqual({ removedFromWorkspace: false })
    expect(calls).toEqual(['wake:env-1'])
    reachable = true
    expect(existsSync(join(userDataPath, 'cloud-ssh', 'keys', alias))).toBe(false)

    // The next time the VM is up for SSH, the revoked key leaves it too.
    control.removeSshKey = vi.fn(async (_sandboxId: string, key: string) => {
      installed = installed.filter((k) => k !== key)
      return { port: 2222, user: 'vercel-sandbox', hostKey: HOST_KEY }
    })
    await service.tunnel('evm-1')
    expect(installed).not.toContain(revokedKey)
    expect(installed).toHaveLength(1)
  })

  it('revoking without a key on this device never wakes the VM', async () => {
    const service = createCloudSshService(deps())
    expect(await service.revoke('evm-1')).toEqual({ removedFromWorkspace: true })
    expect(calls).toEqual([])
  })

  it('drops files for a destroyed workspace', async () => {
    const service = createCloudSshService(deps())
    const { alias } = await service.prepare('evm-1')
    runtimes = [cloudRuntime({ status: 'cleaned' })]
    await service.prune()
    expect(existsSync(join(userDataPath, 'cloud-ssh', 'keys', alias))).toBe(false)
    expect(readFileSync(join(userDataPath, 'cloud-ssh', 'config'), 'utf8')).not.toContain(alias)
  })
})
