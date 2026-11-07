import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GeneratedAgentInputNotices } from '../../runtime/generated-agent-input-notices'
import { addEnvironmentFromPairingCode } from '../../../shared/runtime-environment-store'
import { encodePairingOffer } from '../../../shared/pairing'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../../shared/host-runtime-capabilities'
import {
  closeSharedControlTestServers,
  createSharedControlTestServer
} from '../../../shared/remote-runtime/control/remote-runtime-shared-control-test-server'
import { channelHandlerLookup } from './runtime-environments-ipc-test-harness'
import type * as ManagedTunnel from './runtime-environment-managed-tunnel'
import { resetSharedControlSupport } from './runtime-environment-shared-control-support'
import { closeRemoteRuntimeSharedControlConnection } from './runtime-environment-request-connections'

const h = vi.hoisted(() => ({ handle: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: () => [] },
  ipcMain: { handle: h.handle, on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() }
}))

// A managed host's resolution a test holds open, as one shared producer for every waiter.
const prep = vi.hoisted(() => ({ held: 0, hold: Promise.resolve(), entered: 0 }))
vi.mock('./runtime-environment-managed-tunnel', async (importOriginal) => {
  const actual = await importOriginal<typeof ManagedTunnel>()
  return {
    ...actual,
    resolveManagedRuntimeEnvironment: async (
      ...args: Parameters<typeof actual.resolveManagedRuntimeEnvironment>
    ) => {
      if (prep.held > 0) {
        prep.held -= 1
        prep.entered += 1
        await prep.hold
      }
      return actual.resolveManagedRuntimeEnvironment(...args)
    }
  }
})

const { registerRuntimeHandlers } = await import('../runtime')
const { registerRuntimeEnvironmentPassiveHandlers } =
  await import('./runtime-environment-connectivity-handlers')

const SEND = 'terminal.sendGeneratedInput'
const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
  resetSharedControlSupport()
  await closeSharedControlTestServers()
})

function windowEvent() {
  const mainFrame = {}
  const sender = { id: 7, mainFrame, on: vi.fn(), once: vi.fn(), send: vi.fn() }
  return { sender, senderFrame: mainFrame }
}

// The window's IPC call into main for a host paired with `server`, held by `notices`.
function pairedChain(
  server: Awaited<ReturnType<typeof createSharedControlTestServer>>,
  notices: GeneratedAgentInputNotices
) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-generated-input-chain-'))
  cleanups.push(() => rmSync(userDataPath, { recursive: true, force: true }))
  const { id: environmentId } = addEnvironmentFromPairingCode(userDataPath, {
    name: 'host',
    pairingCode: encodePairingOffer(server.offer)
  })
  cleanups.push(() => closeRemoteRuntimeSharedControlConnection(environmentId))
  h.handle.mockReset()
  const remote = registerRuntimeHandlers({
    generatedInputNotices: notices,
    cleanupSubscriptionsForConnection: vi.fn(),
    getRuntimeId: () => 'local-runtime'
  } as never)
  registerRuntimeEnvironmentPassiveHandlers(() => userDataPath, undefined, remote)
  const call = channelHandlerLookup(h.handle)('runtimeEnvironments:call')
  return (args: Record<string, unknown>) =>
    Promise.resolve(call(windowEvent(), { selector: environmentId, ...args }))
}

const generated = (operationId: string) => ({
  method: SEND,
  params: {
    terminal: { handle: 'host-terminal', expectedRuntimeId: 'runtime-test' },
    text: 'exact\r\ntext 😀',
    submit: true,
    agent: 'claude',
    retainNotice: true,
    operationId,
    window: 'window-a'
  },
  timeoutMs: 5000
})

// Acceptance group 1, one production chain: the window's IPC call, held at main's authenticated
// ingress, goes through the real callRuntimeEnvironment, the real status probe and support
// routing, onto the real shared E2EE socket of a paired host. Only the host endpoint is a fixture.
it('is not sent before its own shared-socket frame, possibly sent after it, settled by the answer', async () => {
  const notices = new GeneratedAgentInputNotices()
  const certainty = (id: string) => notices.noticeOf(id)?.certainty ?? 'none'
  // What the host saw, and what this window's runtime said, at each request the host received.
  const seen: string[] = []
  const server = await createSharedControlTestServer({
    delayedMethods: [SEND],
    resultForRequest: (method) => {
      seen.push(`${method}:${certainty('op-delivered')}`)
      return method === 'status.get'
        ? { runtimeId: 'runtime-test', capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY] }
        : { delivery: { outcome: 'delivered' } }
    }
  })
  const call = pairedChain(server, notices)
  const send = (operationId: string) => call(generated(operationId))

  const delivered = send('op-delivered')
  expect(certainty('op-delivered')).toBe('not-sent')
  await vi.waitFor(() => expect(seen).toContain(`${SEND}:unconfirmed`))
  // The routing probe ran before the frame, while the request still read as not sent; the frame
  // itself only ever arrived after it was marked. (A later status request on another socket may
  // interleave; it carries nothing of this request.)
  expect(seen[0]).toBe('status.get:not-sent')
  expect(seen.filter((entry) => entry.startsWith(SEND))).toEqual([`${SEND}:unconfirmed`])
  server.flushDelayedResponses()
  await expect(delivered).resolves.toMatchObject({ ok: true })
  expect(certainty('op-delivered')).toBe('none')

  // The same chain, answer lost after its frame left: possibly sent, still held, never resent.
  const lost = send('op-lost')
  await vi.waitFor(() =>
    expect(server.requests.filter(({ method }) => method === SEND)).toHaveLength(2)
  )
  server.closeClients()
  await lost
  expect(certainty('op-lost')).toBe('unconfirmed')
  expect(notices.isPending('op-lost')).toBe(true)
  expect(server.requests.filter(({ method }) => method === SEND)).toHaveLength(2)
})

// P20: a generated request whose end passes while main waits for its managed host's resolution
// stops waiting at that end. Its queue callback unwinds and frees its slot while the resolution is
// still held for others: with every slot taken by such requests, a live sibling goes through. The
// resolution finishing later sends none of them; a request in time is delivered.
it('frees a held preparation’s slot at its end, before the resolution finishes', async () => {
  const notices = new GeneratedAgentInputNotices()
  const certainty = (id: string) => notices.noticeOf(id)?.certainty ?? 'none'
  const server = await createSharedControlTestServer({
    resultForRequest: (method) =>
      method === 'status.get'
        ? { runtimeId: 'runtime-test', capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY] }
        : { delivery: { outcome: 'delivered' } }
  })
  const call = pairedChain(server, notices)
  let release: () => void = () => {}
  prep.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  prep.held = 8
  prep.entered = 0
  const ids = Array.from({ length: 8 }, (_, index) => `op-held-${index}`)
  let settled = 0
  const expiring = ids.map((id) =>
    call({ ...generated(id), generatedInputEnd: Date.now() + 300 }).finally(() => {
      settled += 1
    })
  )
  try {
    await vi.waitFor(() => expect(prep.entered).toBe(8))
    // Every slot is held; the sibling can run only once those callbacks unwound.
    const sibling = call({ method: 'terminal.list', params: {}, timeoutMs: 5000 })
    await expect(sibling).resolves.toMatchObject({ ok: true })
    expect(settled).toBe(8)
    for (const response of await Promise.all(expiring)) {
      expect(response).toMatchObject({ ok: false, error: { code: 'runtime_timeout' } })
    }
    expect(ids.map(certainty)).toEqual(Array(8).fill('not-sent'))
  } finally {
    release()
  }
  // The resolution's late finish sends nothing of them.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(server.requests.filter(({ method }) => method === SEND)).toEqual([])
  expect(ids.map(certainty)).toEqual(Array(8).fill('not-sent'))

  await expect(
    call({ ...generated('op-in-time'), generatedInputEnd: Date.now() + 5000 })
  ).resolves.toMatchObject({ ok: true })
  expect(server.requests.filter(({ method }) => method === SEND)).toHaveLength(1)
  expect(certainty('op-in-time')).toBe('none')
})
