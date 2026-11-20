import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type * as Registry from '../../../../managed-agent-cli/managed-agent-cli-registry'
import { writeRuntimeReleaseReceipt } from '../../../../node-runtime/managed-runtime-release'
import type { RpcContext } from '../../core'
import { MANAGED_RUNTIME_INSTALL_METHODS } from './managed-runtime-install'

const host = vi.hoisted(() => ({ dataDirectory: '' }))
vi.mock('../../../../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => host.dataDirectory
}))
vi.mock('../../../agent-session/launch/structured-agent-launch-support', () => ({
  // A home without agy, so no host program answers.
  resolveHostStructuredAgentLaunchEnvironment: async () => ({
    PATH: '',
    HOME: join(tmpdir(), 'orca-no-agy-home')
  })
}))
// The download never answers until its cancel.
vi.mock('../../../../network/http-client', () => ({
  getMainHttpClient: () => ({
    fetch: (_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.throwIfAborted()
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      })
  })
}))
// A host with one loaded chat, which a requested close stops.
const chats = vi.hoisted((): { loaded: string[]; closed: string[] } => ({ loaded: [], closed: [] }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  async (actual) => ({
    ...(await actual<object>()),
    getStructuredAgentSessionHost: () => ({
      loadedSessionIds: () => [...chats.loaded],
      sessionAgent: () => 'grok',
      close: async (id: string) => {
        chats.closed.push(id)
        chats.loaded = chats.loaded.filter((loaded) => loaded !== id)
      }
    })
  })
)
const pin = vi.hoisted(() => ({
  version: '1.0',
  url: 'https://example.test/agent-1.0.tar.gz',
  archiveSha256: 'a'.repeat(64),
  archiveBytes: 10,
  members: [{ path: 'agent', sha256: 'b'.repeat(64), bytes: 5 }]
}))
vi.mock('../../../../managed-agent-cli/managed-agent-cli-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof Registry>()
  return {
    ...actual,
    managedAgentCli: () => ({
      runtime: { label: 'Agent', root: (data: string) => `${data}/rt`, pin: () => pin },
      available: () => true,
      executable: (folder: string) => join(folder, 'agent')
    })
  }
})

const [subscribeMethod, installMethod, cancelMethod, removeMethod] = MANAGED_RUNTIME_INSTALL_METHODS
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only the settings store and the stream registry.
const ctx = {
  runtime: {
    requireStore: () => ({ getSettings: () => ({}) }),
    registerOwnedSubscriptionCleanup: (_id: string, cleanup: () => void) => ({
      releaseIfCurrent: cleanup
    })
  }
} as unknown as RpcContext

it('pushes a snapshot, then the install another client starts, until the transport closes', async () => {
  host.dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-install-rpc-'))
  const transport = new AbortController()
  const frames: unknown[] = []
  const watcher = { ...ctx, signal: transport.signal }
  await subscribeMethod.handler({ agent: 'antigravity' }, watcher, (frame) => frames.push(frame))
  expect(frames).toEqual([
    expect.objectContaining({ available: true, installedVersion: null, operation: null })
  ])
  const started = await installMethod.handler({ agent: 'antigravity' }, ctx)
  const id = String(started.operation?.id)
  await vi.waitFor(() =>
    expect(frames.at(-1)).toMatchObject({ operation: { id, phase: 'downloading' } })
  )
  // Cancel answers with the outcome once the run has unwound.
  const outcome = await cancelMethod.handler({ agent: 'antigravity', operationId: id }, ctx)
  expect(outcome).toMatchObject({ id, phase: 'cancelled' })
  await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ operation: { phase: 'cancelled' } }))

  transport.abort()
  const seen = frames.length
  const again = await installMethod.handler({ agent: 'antigravity' }, ctx)
  await cancelMethod.handler(
    { agent: 'antigravity', operationId: String(again.operation?.id) },
    ctx
  )
  expect(frames).toHaveLength(seen)
  await rm(host.dataDirectory, { recursive: true, force: true })
})

it('removes the files only once the chats that may run them are stopped', async () => {
  host.dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-remove-rpc-'))
  // Another agent than above: each agent's installation keeps the data folder it started with.
  const agent = 'grok'
  const release = join(host.dataDirectory, 'rt', pin.version)
  await mkdir(release, { recursive: true })
  await writeFile(join(release, 'agent'), 'agent', { mode: 0o755 })
  await writeRuntimeReleaseReceipt(release, pin)
  const transport = new AbortController()
  const frames: unknown[] = []
  await subscribeMethod.handler({ agent }, { ...ctx, signal: transport.signal }, (frame) =>
    frames.push(frame)
  )
  chats.loaded = ['chat-1']
  const { operation } = await removeMethod.handler({ agent }, ctx)
  await vi.waitFor(() =>
    expect(frames.at(-1)).toMatchObject({ operation: { id: operation?.id, phase: 'succeeded' } })
  )

  expect(frames.at(-1)).toMatchObject({ installedVersion: null, source: null })
  expect(chats.closed).toEqual(['chat-1'])
  expect(existsSync(release)).toBe(false)
  transport.abort()
  await rm(host.dataDirectory, { recursive: true, force: true })
})

it("lists Orca's installed agy as an installed agent only while it may run", async () => {
  const { reclaimManagedRuntimeReleasesAtLaunch } = await import('./managed-runtime-install')
  const { readInstalledManagedAgents } =
    await import('../../../../preflight/managed-agent-detection')
  const { rememberManagedAgentRelease } =
    await import('../../../../managed-agent-cli/managed-agent-cli-registry')
  host.dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-detect-rpc-'))
  let settings: Record<string, unknown> = {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the settings store is read.
  const runtime = {
    requireStore: () => ({ getSettings: () => settings })
  } as unknown as Parameters<typeof reclaimManagedRuntimeReleasesAtLaunch>[0]
  reclaimManagedRuntimeReleasesAtLaunch(runtime)
  rememberManagedAgentRelease('antigravity', join(host.dataDirectory, 'agy', '1.5.13'))

  expect(await readInstalledManagedAgents()).toContain('antigravity')
  settings = { antigravityManagedAgyEnabled: false }
  expect(await readInstalledManagedAgents()).not.toContain('antigravity')

  rememberManagedAgentRelease('antigravity', null)
  await rm(host.dataDirectory, { recursive: true, force: true })
})
