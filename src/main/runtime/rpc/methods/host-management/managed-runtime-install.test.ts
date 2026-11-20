import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { acpLaunchSpecFor } from '../../../../acp/launch/acp-launch-registry'
import type * as LaunchSpecs from '../../../../acp/launch/acp-launch-registry'
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
  }),
  structuredAgentHostAlternativeReady: async () => false
}))
// The download never answers until its cancel; agy's release lookup fails at once.
vi.mock('../../../../network/http-client', () => ({
  getMainHttpClient: () => ({
    fetch: (url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        if (url.includes('antigravity-cli-auto-updater')) {
          reject(new Error('offline'))
        }
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
      sessionAgent: () => 'hermes',
      close: async (id: string) => {
        chats.closed.push(id)
        chats.loaded = chats.loaded.filter((loaded) => loaded !== id)
      }
    })
  })
)
vi.mock('../../../../acp/launch/acp-launch-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof LaunchSpecs>()
  const { AcpLaunchGate } = await import('../../../../acp/launch/acp-launch-gate')
  const launchGate = new AcpLaunchGate('Agent')
  const pin = {
    version: '1.0',
    url: 'https://example.test/agent-1.0.tar.gz',
    archiveSha256: 'a'.repeat(64),
    archiveBytes: 10,
    members: [{ path: 'server', sha256: 'b'.repeat(64), bytes: 6 }]
  }
  const managedRuntime = { label: 'Agent', root: (data: string) => `${data}/rt`, pin: () => pin }
  return {
    ...actual,
    acpLaunchSpecFor: (agent: string) => {
      const spec = actual.acpLaunchSpecFor(agent)
      return spec && { ...spec, command: 'orca-rpc-managed-test', managedRuntime, launchGate }
    }
  }
})

const [subscribeMethod, installMethod, cancelMethod, removeMethod] = MANAGED_RUNTIME_INSTALL_METHODS
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers read only the settings store and the stream registry.
const ctx = {
  runtime: {
    // Antigravity installs Orca's server, not its agy, for an account type agy lacks.
    requireStore: () => ({
      getSettings: () => ({ antigravityChatAuth: { method: 'gemini-api-key' } })
    }),
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

it('removes the files only once every chat and unclosed child that may run them is stopped', async () => {
  host.dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-remove-rpc-'))
  const agent = 'hermes'
  const spec = acpLaunchSpecFor(agent)
  const pin = spec?.managedRuntime?.pin()
  if (!spec?.launchGate || !pin) {
    throw new Error('managed test spec missing')
  }
  const release = join(host.dataDirectory, 'rt', pin.version)
  await mkdir(release, { recursive: true })
  await writeFile(join(release, 'server'), 'server', { mode: 0o755 })
  await writeRuntimeReleaseReceipt(release, pin)
  const transport = new AbortController()
  const frames: unknown[] = []
  await subscribeMethod.handler({ agent }, { ...ctx, signal: transport.signal }, (frame) =>
    frames.push(frame)
  )
  const removed = async () => {
    const { operation } = await removeMethod.handler({ agent }, ctx)
    await vi.waitFor(() =>
      expect(frames.at(-1)).toMatchObject({
        operation: { id: operation?.id, phase: expect.stringMatching(/ed$/) }
      })
    )
    return frames.at(-1)
  }
  // A sign-in child whose close was never proven still holds the files.
  const child = { close: vi.fn(async () => false), onExit: () => {} }
  spec.launchGate.retain(child)
  chats.loaded = ['chat-1']
  expect(await removed()).toMatchObject({
    installedVersion: pin.version,
    operation: { kind: 'remove', phase: 'failed', error: expect.stringContaining('stopped') }
  })

  child.close.mockResolvedValue(true)
  chats.loaded = ['chat-2']
  expect(await removed()).toMatchObject({
    installedVersion: null,
    source: null,
    operation: { kind: 'remove', phase: 'succeeded' }
  })
  expect(chats.closed).toEqual(['chat-1', 'chat-2'])
  expect(existsSync(join(host.dataDirectory, 'rt'))).toBe(false)
  transport.abort()
  await rm(host.dataDirectory, { recursive: true, force: true })
})

it("follows Antigravity's install target when the chat's account type changes", async () => {
  host.dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-target-rpc-'))
  let settings: Record<string, unknown> = { antigravityChatAuth: { method: 'gemini-api-key' } }
  const listeners = new Set<(updates: Record<string, unknown>) => void>()
  const transport = new AbortController()
  const frames: unknown[] = []
  const revision = (frame: unknown) =>
    typeof frame === 'object' && frame !== null && 'revision' in frame
      ? Number(frame.revision)
      : Number.NaN
  const watcher = {
    ...ctx,
    signal: transport.signal,
    runtime: {
      ...ctx.runtime,
      requireStore: () => ({
        getSettings: () => settings,
        onSettingsChanged: (listener: (updates: Record<string, unknown>) => void) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }
      })
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only the settings store and the stream registry.
  const stream = watcher as unknown as RpcContext
  await subscribeMethod.handler({ agent: 'antigravity' }, stream, (frame) => frames.push(frame))
  // Orca's server, for an account type agy lacks.
  expect(frames).toEqual([expect.objectContaining({ version: '1.0' })])

  settings = {}
  listeners.forEach((listener) => listener({ antigravityChatAuth: undefined }))
  // Orca's agy, whose release this host could not look up.
  await vi.waitFor(() => expect(frames.at(-1)).toMatchObject({ version: null }))
  expect(revision(frames.at(-1))).toBeGreaterThan(revision(frames[0]))
  transport.abort()
  await rm(host.dataDirectory, { recursive: true, force: true })
})

it('acts on the program the client showed, not the one the host now prefers', async () => {
  host.dataDirectory = await mkdtemp(join(tmpdir(), 'orca-runtime-program-rpc-'))
  // The API-key setting prefers Orca's server.
  const state = await installMethod.handler({ agent: 'antigravity', program: 'cli' }, ctx)

  expect(state).toMatchObject({ agent: 'antigravity', program: 'cli' })
  await rm(host.dataDirectory, { recursive: true, force: true })
})
