import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { resolveAcpLaunchCommand } from '../acp/launch/acp-launch-command'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import { GROK, openAcpAdapterRig } from '../acp/session/testing/acp-structured-adapter.test-support'
import { writeRuntimeReleaseReceipt } from '../node-runtime/managed-runtime-release'
import {
  createAcpModelCatalogProbe,
  type AcpModelCatalogProbeDeps
} from '../acp/discovery/acp-model-catalog-probe'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const MANAGED = acpLaunchSpecFor('antigravity')!
const HOST = MANAGED.hostBackend!.spec
const ZED = { name: 'zed', version: '0.0.0' }
const ORCA = { name: 'orca', version: '1' }

async function initializeParams(spec: AcpLaunchSpec, version?: string): Promise<unknown> {
  const rig = await openAcpAdapterRig({
    spec,
    ...(version ? { launch: { version } } : {}),
    initialize: { authMethods: [{ id: 'oauth-personal', name: 'Google' }] }
  })
  await rig.acquire()
  return (await rig.frame('initialize')).params
}

it.each([
  ['the managed server 1.4.1', MANAGED, '1.4.1', ZED],
  ['the managed server 1.5.1', MANAGED, '1.5.1', ORCA],
  ["the host's agy of unknown version", HOST, undefined, ZED],
  ['other agents', GROK, undefined, ORCA]
])(
  'initializes %s with the identity that unlocks its models',
  async (_label, spec, version, expected) => {
    expect(await initializeParams(spec, version)).toMatchObject({ clientInfo: expected })
  }
)

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

it('launches a managed release with the version its receipt names', async () => {
  const dataDirectory = await managedRelease('1.3.0')
  const launch = resolveAcpLaunchCommand(
    MANAGED,
    { PATH: '' },
    {
      dataDirectory,
      homePath: dataDirectory,
      resolveCommand: (command, options) => join(options?.pathEnv ?? '', command)
    }
  )
  expect(launch.version).toBe('1.3.0')
})

it('uses the legacy client identity when listing models from the older managed server', async () => {
  const dataDirectory = await managedRelease('1.4.1')
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
    close: async () => {}
  }))
  const probe = createAcpModelCatalogProbe(MANAGED, {
    resolveEnvironment: async () => ({ PATH: '' }),
    resolveCommand: (command, options) => join(options?.pathEnv ?? '', command),
    inheritedEnv: { HTTPS_PROXY: 'http://proxy.invalid:8080' },
    homePath: dataDirectory,
    dataDirectory,
    connectSession
  })
  await expect(
    probe({ variable: 'GEMINI_HOME', path: join(dataDirectory, 'antigravity-chat') })
  ).rejects.toThrow('listing stopped')
  expect(connectSession.mock.calls[0]?.[1]).toMatchObject({ clientInfo: ZED })
})
