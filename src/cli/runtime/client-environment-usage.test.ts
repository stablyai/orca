import type * as nodeFs from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from './client'
import { addEnvironmentFromPairingCode } from './environments'
import { encodePairingOffer } from '../../shared/remote-runtime/pairing/pairing'
import { RUNTIME_PROTOCOL_VERSION } from '../../shared/protocol-version'

const mocks = vi.hoisted(() => {
  const state: { unownedPath: string | null } = { unownedPath: null }
  return { remote: vi.fn(), remotePreflight: vi.fn(), state }
})

vi.mock('./websocket-transport', () => ({
  sendWebSocketRequest: mocks.remote,
  sendWebSocketRequestWithStatusPreflight: mocks.remotePreflight
}))

// A profile directory owned by another account refuses chmod even though it stays readable.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeFs>()
  const chmodSync: typeof actual.chmodSync = (path, mode) => {
    if (path === mocks.state.unownedPath) {
      throw Object.assign(new Error(`EPERM: operation not permitted, chmod '${path}'`), {
        code: 'EPERM'
      })
    }
    actual.chmodSync(path, mode)
  }
  return { ...actual, default: { ...actual, chmodSync }, chmodSync }
})

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  mocks.state.unownedPath = null
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function success(result: unknown) {
  return { id: 'request-1', ok: true, result, _meta: { runtimeId: 'runtime-remote' } }
}

// Windows hardens the profile through ACLs, not chmod, so this EPERM cannot be injected there.
const posixIt = process.platform === 'win32' ? it.skip : it

posixIt('returns remote replies when the saved environment store cannot be updated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cli-env-usage-'))
  roots.push(root)
  const pairingCode = encodePairingOffer({
    v: 2,
    endpoint: 'ws://127.0.0.1:6768',
    deviceToken: 'fixture-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
    scope: 'runtime'
  })
  addEnvironmentFromPairingCode(root, { name: 'workstation', pairingCode })
  mocks.state.unownedPath = root
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  mocks.remote.mockResolvedValue(success({ server: 'remote' }))
  mocks.remotePreflight.mockImplementation(
    async (_connection, _method, _params, _timeoutMs, validateStatus) => {
      validateStatus(
        success({
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: RUNTIME_PROTOCOL_VERSION
        })
      )
      return success({ worktrees: [] })
    }
  )
  const client = new RuntimeClient(root, 5_000, null, 'workstation')

  // Last-used bookkeeping is best effort; it must not fail a command whose reply already arrived.
  await expect(client.call('status.get')).resolves.toMatchObject({ result: { server: 'remote' } })
  await expect(client.call('worktree.list')).resolves.toMatchObject({ result: { worktrees: [] } })
  // Proves the store write really failed, so the replies above survived it rather than skipped it.
  expect(warn).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('EPERM'))
})
