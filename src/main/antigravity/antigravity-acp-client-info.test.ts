import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { acpClientInfo } from '../acp/launch/acp-client-info'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import { writeRuntimeReleaseReceipt } from '../node-runtime/managed-runtime-release'
import {
  createAcpModelCatalogProbe,
  type AcpModelCatalogProbeDeps
} from '../acp/discovery/acp-model-catalog-probe'

const MANAGED = acpLaunchSpecFor('antigravity')!
const HOST = MANAGED.hostBackend!.spec
const ZED = { name: 'zed', version: '0.0.0' }
const ORCA = { name: 'orca', version: '1' }

// Google's server 1.5.0 and 1.5.2 keep Claude and GPT-OSS for allowlisted names only; agy does not.
it.each([
  ['the managed server 1.5.0', MANAGED, '1.5.0', ZED],
  ['the managed server 1.5.2', MANAGED, '1.5.2', ZED],
  ["the host's agy 1.5.13", HOST, '1.5.13', ORCA],
  ["the host's agy of unknown version", HOST, null, ZED]
])('introduces Orca to %s by a name that keeps every model', (_label, spec, version, expected) => {
  expect(acpClientInfo(spec, version)).toEqual(expected)
})

async function managedRelease(version: string): Promise<string> {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-agy-release-'))
  onTestFinished(() => rm(dataDirectory, { recursive: true, force: true }))
  const folder = join(MANAGED.managedRuntime!.root(dataDirectory), version)
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, 'server'), 'x')
  await chmod(join(folder, 'server'), 0o755)
  await writeRuntimeReleaseReceipt(folder, {
    version,
    url: 'https://example.invalid/agy.zip',
    archiveSha256: 'a'.repeat(64),
    archiveBytes: 1,
    members: [{ path: 'server', sha256: 'unused', bytes: 1 }]
  })
  return dataDirectory
}

it('lists the installed 1.5.2 server under the name that keeps its Claude and GPT-OSS models', async () => {
  const dataDirectory = await managedRelease('1.5.2')
  const connectSession = vi.fn<NonNullable<AcpModelCatalogProbeDeps['connectSession']>>(() => ({
    initialize: async () => {
      throw new Error('listing stopped')
    },
    start: async () => {
      throw new Error('unused')
    },
    setConfigOption: async () => {
      throw new Error('unused')
    },
    deleteSession: async () => ({}),
    close: async () => true,
    onExit: () => {}
  }))
  const probe = createAcpModelCatalogProbe(MANAGED, {
    resolveEnvironment: async () => ({ PATH: '' }),
    resolveCommand: (command, options) => join(options?.pathEnv ?? '', command),
    inheritedEnv: {},
    homePath: dataDirectory,
    dataDirectory,
    connectSession
  })
  await expect(
    probe({ variable: 'GEMINI_HOME', path: join(dataDirectory, 'antigravity-chat') })
  ).rejects.toThrow('listing stopped')
  expect(connectSession.mock.calls[0]?.[1]).toMatchObject({ clientInfo: ZED })
})
