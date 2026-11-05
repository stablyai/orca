import { mkdir, mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  RUNTIME_RELEASE_RECEIPT,
  writeRuntimeReleaseReceipt
} from '../node-runtime/managed-runtime-release'
import { createAcpStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { GROK, openAcpAdapterRig } from './acp-structured-adapter.test-support'

afterEach(() => closeProviderTimelineRigs())

it('prefers the pin even when older, else a complete installed or external copy', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-acp-managed-'))
  onTestFinished(() => rm(dataDirectory, { recursive: true, force: true }))
  const homePath = join(dataDirectory, 'home')
  const command = `orca-managed-${basename(dataDirectory)}`
  const root = join(dataDirectory, 'agent-runtimes', 'grok')
  const pin = {
    version: '1.0',
    url: 'https://example.test/grok-1.0.zip',
    archiveSha256: 'a'.repeat(64),
    archiveBytes: 10,
    members: [
      { path: command, sha256: 'b'.repeat(64), bytes: 6 },
      { path: 'harness', sha256: 'c'.repeat(64), bytes: 7 }
    ]
  }
  const spec = {
    ...GROK,
    command,
    managedRuntime: { label: 'Grok', root: () => root, pin: () => pin }
  }
  const spawn = async () => {
    const resolveLaunch = createAcpStructuredLaunchResolver(spec, {
      store: {
        getRecord: () => ({
          ...agentSessionRecordFixture(),
          provider: 'grok',
          providerHandleChain: [],
          accountHome: { variable: 'GROK_HOME', path: join(dataDirectory, '.grok') }
        }),
        pinLaunchDirectory: vi.fn()
      },
      readJournal: () => null,
      resolveEnvironment: async () => ({ PATH: '', HOME: homePath }),
      dataDirectory
    })
    const rig = await openAcpAdapterRig({ spec, deps: { resolveLaunch } })
    await rig.acquire()
    return rig.child().launch.command
  }
  await expect(spawn()).rejects.toMatchObject({ reason: 'runtimeNotInstalled' })

  // A server without its companion is an incomplete runtime.
  const localBin = join(homePath, '.local', 'bin')
  await mkdir(localBin, { recursive: true })
  await writeFile(join(localBin, command), '', { mode: 0o755 })
  await expect(spawn()).rejects.toMatchObject({ reason: 'runtimeNotInstalled' })

  const fallback = join(root, '1.1')
  await mkdir(fallback, { recursive: true })
  await writeFile(join(fallback, command), 'server', { mode: 0o755 })
  await writeFile(join(fallback, 'harness'), 'harness', { mode: 0o755 })
  await writeRuntimeReleaseReceipt(fallback, {
    ...pin,
    version: '1.1',
    archiveSha256: 'd'.repeat(64)
  })
  expect(await spawn()).toBe(join(fallback, command))

  const release = join(root, '1.0')
  await mkdir(release, { recursive: true })
  await writeFile(join(release, command), 'server', { mode: 0o755 })
  await writeFile(join(release, 'harness'), 'harness', { mode: 0o755 })
  await writeFile(
    join(release, RUNTIME_RELEASE_RECEIPT),
    JSON.stringify({
      releaseId: pin.archiveSha256,
      version: '1.0',
      platform: process.platform,
      arch: process.arch,
      members: pin.members.map(({ path, bytes }) => ({ path, bytes }))
    })
  )
  await writeFile(join(localBin, 'harness'), '', { mode: 0o755 })
  expect(await spawn()).toBe(join(release, command))

  await truncate(join(fallback, command), 2)
  await truncate(join(release, command), 2)
  expect(await spawn()).toBe(await realpath(join(localBin, command)))
})
