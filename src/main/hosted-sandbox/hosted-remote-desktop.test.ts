import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parseEphemeralVmRecipeResult } from '../../shared/ephemeral-vm-recipes'
import { upsertEphemeralVmRuntime } from '../../shared/ephemeral-vm-runtime-store'
import { createHostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { createHostedSandboxDriver } from './hosted-sandbox-driver'
import { createHostedSandboxStepProvider } from './hosted-sandbox-recipe'
import { createFakeHostedControlPlane } from './fake-hosted-control-plane.test-support'
import { cloudSandboxIdForEnvironment, openCloudRemoteDesktop } from './hosted-remote-desktop'

const ENV = 'env-cloud-1'

async function setup() {
  const plane = createFakeHostedControlPlane()
  const client = createHostedSandboxControlPlaneClient({
    baseUrl: 'https://sandbox.cloud.test',
    getAccessToken: async () => plane.token,
    fetch: plane.fetch
  })
  const step = createHostedSandboxStepProvider(createHostedSandboxDriver(client))
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-remote-desktop-'))
  const created = await step({
    mode: 'create',
    repoPath: userDataPath,
    context: { recipeId: 'cloud', repoPath: userDataPath, instanceId: 'inst-1' }
  })
  const parsed = parseEphemeralVmRecipeResult(created.stdout)
  if (!parsed.ok) {
    throw new Error('create failed')
  }
  upsertEphemeralVmRuntime(userDataPath, {
    id: 'rt-1',
    recipeId: 'cloud',
    recipe: {
      id: 'cloud',
      name: 'Orca Cloud',
      create: 'orca-cloud create',
      provider: 'orca-cloud'
    },
    runtimeEnvironmentId: ENV,
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1,
    updatedAt: 1,
    recipeResult: parsed.result
  })
  const openForward = vi.fn(async () => ({ ok: true as const, localPort: 6081 }))
  return { plane, client, userDataPath, openForward }
}

describe('Open Remote Desktop for an Orca Cloud workspace', () => {
  it('starts the desktop through the control plane and forwards its loopback port', async () => {
    const { plane, client, userDataPath, openForward } = await setup()
    const sandboxId = cloudSandboxIdForEnvironment(userDataPath, ENV)
    expect(sandboxId).toBe([...plane.sandboxes.keys()][0])
    const result = await openCloudRemoteDesktop({ userDataPath, client, openForward }, ENV)
    expect(result).toEqual({
      ok: true,
      localPort: 6081,
      url: 'http://localhost:6081/vnc.html?autoconnect=1&resize=remote&reconnect=1&reconnect_delay=1000#password=Ab3dE6gH'
    })
    expect(plane.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: `/v1/sandboxes/${sandboxId}/desktop`
    })
    expect(openForward).toHaveBeenCalledWith({
      environmentId: ENV,
      remotePort: 6080,
      reason: 'user',
      label: 'Remote Desktop'
    })
  })

  it('refuses environments that are not Orca Cloud without calling anything', async () => {
    const { plane, client, userDataPath, openForward } = await setup()
    const before = plane.requests.length
    expect(
      await openCloudRemoteDesktop({ userDataPath, client, openForward }, 'env-ssh-box')
    ).toEqual({ ok: false, code: 'not_cloud' })
    expect(await openCloudRemoteDesktop({ userDataPath, client: null, openForward }, ENV)).toEqual({
      ok: false,
      code: 'not_cloud'
    })
    expect(plane.requests.length).toBe(before)
    expect(openForward).not.toHaveBeenCalled()
  })

  it('names old images, sleeping workspaces and forward failures distinctly', async () => {
    const { plane, client, userDataPath, openForward } = await setup()
    plane.desktopInstalled = false
    expect(await openCloudRemoteDesktop({ userDataPath, client, openForward }, ENV)).toEqual({
      ok: false,
      code: 'not_installed'
    })
    plane.desktopInstalled = true
    for (const sandbox of plane.sandboxes.values()) {
      Object.assign(sandbox, { status: 'suspended', session: null })
    }
    expect(await openCloudRemoteDesktop({ userDataPath, client, openForward }, ENV)).toEqual({
      ok: false,
      code: 'not_running'
    })
    expect(openForward).not.toHaveBeenCalled()
    for (const sandbox of plane.sandboxes.values()) {
      Object.assign(sandbox, { status: 'running' })
    }
    const refused = vi.fn(async () => ({ ok: false as const }))
    expect(
      await openCloudRemoteDesktop({ userDataPath, client, openForward: refused }, ENV)
    ).toEqual({ ok: false, code: 'forward_failed' })
  })

  it('asks for sign-in when the control plane refuses the token', async () => {
    const { userDataPath, openForward } = await setup()
    const plane = createFakeHostedControlPlane()
    const stale = createHostedSandboxControlPlaneClient({
      baseUrl: 'https://sandbox.cloud.test',
      getAccessToken: async () => 'expired',
      fetch: plane.fetch
    })
    expect(await openCloudRemoteDesktop({ userDataPath, client: stale, openForward }, ENV)).toEqual(
      { ok: false, code: 'signed_out' }
    )
  })
})
