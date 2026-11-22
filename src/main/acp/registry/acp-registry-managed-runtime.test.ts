import { beforeEach, describe, expect, it, vi } from 'vitest'

const responses = new Map<string, () => Response>()
vi.mock('../../network/http-client', () => ({
  getMainHttpClient: () => ({
    fetch: async (url: string, init?: RequestInit) =>
      responses.get(`${init?.method ?? 'GET'} ${url}`)?.() ?? new Response(null, { status: 404 })
  })
}))
vi.mock('../../node-runtime/linux-libc-probe', () => ({ isMuslHost: () => false }))

const ARCHIVE = 'https://example.test/v/agent-package.tar.gz'
const SHA = 'ab'.repeat(32)

function listRegistry(version: string, cmd: string): void {
  const registry = {
    agents: [
      {
        id: 'agent',
        version,
        distribution: {
          binary: Object.fromEntries(
            ['darwin', 'linux', 'windows'].flatMap((os) =>
              ['aarch64', 'x86_64'].map((cpu) => [`${os}-${cpu}`, { archive: ARCHIVE, cmd }])
            )
          )
        }
      }
    ]
  }
  responses.set(
    'GET https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',
    () => new Response(JSON.stringify(registry))
  )
}

async function pinFor(minimumVersions: readonly string[]) {
  vi.resetModules()
  const { acpRegistryManagedRuntime } = await import('./acp-registry-managed-runtime')
  const { runtime } = acpRegistryManagedRuntime({
    label: 'Agent',
    agent: 'agent',
    registryId: 'agent',
    command: () => 'bin/agent',
    minimumVersions
  })
  await runtime.refreshPin?.()
  return runtime.pin()
}

describe('acpRegistryManagedRuntime', () => {
  beforeEach(() => {
    responses.clear()
    responses.set(`GET ${ARCHIVE}.sha256`, () => new Response(`${SHA}  agent-package.tar.gz\n`))
    responses.set(
      `HEAD ${ARCHIVE}`,
      () => new Response(null, { headers: { 'content-length': '1234' } })
    )
  })

  it("pins a listing without a hash to the publisher's checksum beside the archive", async () => {
    listRegistry('2.3.2', './bin/agent')
    expect(await pinFor(['2.0.0'])).toEqual({
      version: '2.3.2',
      url: ARCHIVE,
      archiveSha256: SHA,
      archiveBytes: 1234,
      format: 'tar.gz',
      executables: ['bin/agent']
    })
  })

  it('offers no release below the launch minimum', async () => {
    listRegistry('1.52.0', './bin/agent')
    expect(await pinFor(['2.5.0'])).toBeNull()
  })

  it('offers no release whose command leaves the release folder', async () => {
    listRegistry('2.3.2', '../bin/agent')
    expect(await pinFor(['2.0.0'])).toBeNull()
  })
})
