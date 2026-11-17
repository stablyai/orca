import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DaemonClient } from '../daemon/transport/client/daemon-client'
import type { HostedProviderSpawn } from '../daemon/protocol/daemon-provider-process-protocol'
import { spawnHostedProvider } from '../daemon/server/daemon-provider-spawn'
import { spawnManagedProviderProcess } from './managed-provider-process'
import { installProviderProcessHost } from './provider-process-spawn'

const state = vi.hoisted(() => ({ root: '' }))
vi.mock('../../shared/app-lifecycle/app-environment', () => ({
  getAppEnvironment: () => ({
    getPath: () => state.root,
    getAppPath: () => process.cwd(),
    isPackaged: () => false
  })
}))
vi.mock('../daemon/executable-host/macos/daemon-mac-code-identity', () => ({
  inspectMacProcessCodeIdentity: async () => ({ executablePath: '/host', identity: 'resolved' })
}))

function hostClient(spawns: HostedProviderSpawn[]): DaemonClient {
  const identity = { pid: process.pid, providerSpawn: true as const }
  return {
    getDaemonIdentity: () => identity,
    ensureConnectedWithin: async () => {},
    request: async (type: string, payload: unknown) => {
      if (type === 'probeProviderCwd') {
        return { outcome: 'ok' }
      }
      if (type === 'spawnProvider') {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launcher under test sends this payload type.
        spawns.push(payload as HostedProviderSpawn)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the same payload is the host's input.
        return spawnHostedProvider(payload as HostedProviderSpawn, true)
      }
      return {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launcher uses only these client methods.
  } as unknown as DaemonClient
}

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'orca-hosted-provider-'))
})
afterEach(async () => {
  await rm(state.root, { recursive: true, force: true })
})

describe.runIf(process.platform !== 'win32')('hosted native provider owner', () => {
  it('delivers input, output and the real exit through pipes only this app holds', async () => {
    const spawns: HostedProviderSpawn[] = []
    installProviderProcessHost(async () => hostClient(spawns))
    const managed = spawnManagedProviderProcess(
      {
        command: process.execPath,
        cwd: state.root,
        args: [
          '-e',
          "let s=''; process.stdin.on('data', (d) => (s += d)).on('end', () => { process.stdout.write(s.toUpperCase()); process.exitCode = 7 })"
        ]
      },
      { site: 'hosted-provider-launch-test', inheritedEnv: process.env }
    )
    let output = ''
    managed.child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    const closed = new Promise<unknown[]>((resolve) =>
      managed.child.once('close', (...args: unknown[]) => resolve(args))
    )
    await managed.child.ready
    managed.child.stdin.end('hosted reply')
    // A host that kept its pipe copies would hold output open, so close would never arrive.
    await expect(closed).resolves.toEqual([7, null])
    expect(output).toBe('HOSTED REPLY')
    expect(spawns).toHaveLength(1)
    expect(spawns[0]?.args).toContain(process.execPath)
  })
})
