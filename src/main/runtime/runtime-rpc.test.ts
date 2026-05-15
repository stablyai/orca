/* eslint-disable max-lines -- Why: this integration-style RPC test keeps the request/response contract together so regressions in the external CLI surface are easier to spot. */
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createConnection, type Socket } from 'net'
import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import WebSocket from 'ws'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import * as runtimeMetadataModule from './runtime-metadata'
import { readRuntimeMetadata } from './runtime-metadata'
import { createRuntimeTransportMetadata, OrcaRuntimeRpcServer } from './runtime-rpc'
import { parsePairingCode } from '../../shared/pairing'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'
import { DeviceRegistry } from './device-registry'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

async function sendRequest(
  endpoint: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      const message = buffer.slice(0, newlineIndex)
      socket.end()
      resolve(JSON.parse(message) as Record<string, unknown>)
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
  })
}

// Why: long-poll keepalive tests need every frame, not just the first, because
// we need to count `_keepalive` frames before the terminal success/failure.
// Also exposes the socket so tests can close it mid-wait to exercise the
// long-poll counter decrement path.
type FramedSession = {
  socket: Socket
  frames: Record<string, unknown>[]
  done: Promise<void>
}

function openFramedSession(endpoint: string, request: Record<string, unknown>): FramedSession {
  const frames: Record<string, unknown>[] = []
  const socket = createConnection(endpoint)
  let buffer = ''
  socket.setEncoding('utf8')
  const done = new Promise<void>((resolve, reject) => {
    socket.once('error', (err) => {
      // Why: ECONNRESET is expected when we deliberately destroy the socket
      // mid-wait to probe the counter decrement; surface other errors.
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET') {
        resolve()
        return
      }
      reject(err)
    })
    socket.on('close', () => resolve())
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const raw = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (raw) {
          const frame = JSON.parse(raw) as Record<string, unknown>
          frames.push(frame)
          // Why: the server leaves the socket open after writing the terminal
          // frame (short RPCs expect the client to close); close the client
          // side so `done` resolves once we've captured the response.
          if (frame._keepalive !== true) {
            socket.end()
          }
        }
        newlineIndex = buffer.indexOf('\n')
      }
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
  })
  return { socket, frames, done }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await sleep(20)
  }
}

function connectWs(endpoint: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextWsMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(typeof data === 'string' ? data : data.toString('utf-8'))
    })
  })
}

function waitForWsClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) {
      resolve()
      return
    }
    ws.once('close', () => resolve())
  })
}

async function authenticateMobileWs(pairingUrl: string): Promise<WebSocket> {
  const parsed = parsePairingCode(pairingUrl)
  expect(parsed).toBeTruthy()
  const ws = await connectWs(parsed!.endpoint)
  const mobileKeys = generateKeyPair()
  const serverPublicKey = Uint8Array.from(Buffer.from(parsed!.publicKeyB64, 'base64'))
  const sharedKey = deriveSharedKey(mobileKeys.secretKey, serverPublicKey)

  ws.send(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(mobileKeys.publicKey).toString('base64')
    })
  )
  expect(JSON.parse(await nextWsMessage(ws))).toEqual({ type: 'e2ee_ready' })

  ws.send(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: parsed!.deviceToken }), sharedKey)
  )
  expect(JSON.parse(decrypt(await nextWsMessage(ws), sharedKey)!)).toEqual({
    type: 'e2ee_authenticated'
  })

  return ws
}

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
}

describe('OrcaRuntimeRpcServer', () => {
  const makeStore = (overrides?: { isUnread?: boolean }) => ({
    getRepo: (id: string) =>
      makeStore(overrides)
        .getRepos()
        .find((repo) => repo.id === id),
    getRepos: () => [
      {
        id: 'repo-1',
        path: '/tmp/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1
      }
    ],
    addRepo: () => {},
    updateRepo: (id: string, updates: Record<string, unknown>) =>
      ({
        ...makeStore(overrides).getRepo(id),
        ...updates
      }) as never,
    getAllWorktreeMeta: () => ({
      'repo-1::/tmp/worktree-a': {
        displayName: 'foo',
        comment: '',
        linkedIssue: 123,
        linkedPR: null,
        linkedLinearIssue: null,
        isArchived: false,
        isUnread: overrides?.isUnread ?? false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0
      }
    }),
    getWorktreeMeta: (worktreeId: string) =>
      worktreeId === 'repo-1::/tmp/worktree-a'
        ? (makeStore(overrides).getAllWorktreeMeta()[worktreeId] as never)
        : undefined,
    setWorktreeMeta: (_worktreeId: string, meta: Record<string, unknown>) =>
      ({
        ...makeStore(overrides).getAllWorktreeMeta()['repo-1::/tmp/worktree-a'],
        ...meta
      }) as never,
    removeWorktreeMeta: () => {},
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    })
  })

  it('writes runtime metadata with transport details when started', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    expect(metadata?.runtimeId).toBe(runtime.getRuntimeId())
    expect(metadata?.authToken).toBeTruthy()
    expect(metadata?.transports?.[0]?.endpoint).toBeTruthy()
    expect(metadata?.transports).toEqual(server['transports'])

    await server.stop()
    expect(readRuntimeMetadata(userDataPath)).toMatchObject({
      runtimeId: runtime.getRuntimeId()
    })
  })

  it('creates a pairing offer for the active WebSocket transport', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()

    const offer = server.createPairingOffer({ address: '100.64.1.20', name: 'CLI test' })
    expect(offer.available).toBe(true)
    if (offer.available) {
      expect(offer.endpoint).toContain('100.64.1.20')
      const parsed = parsePairingCode(offer.pairingUrl)
      expect(parsed?.endpoint).toBe(offer.endpoint)
      expect(parsed?.deviceToken).toBeTruthy()
      expect(parsed?.publicKeyB64).toBeTruthy()
      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)?.scope).toBe('runtime')
    }

    await server.stop()
  })

  it('formats pairing-address overrides for IPv6 and host-port tunnel endpoints', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()

    try {
      const ipv6 = server.createPairingOffer({ address: '::1', name: 'IPv6 test' })
      expect(ipv6.available).toBe(true)
      if (ipv6.available) {
        expect(ipv6.endpoint).toMatch(/^ws:\/\/\[::1\]:\d+$/)
        expect(parsePairingCode(ipv6.pairingUrl)?.endpoint).toBe(ipv6.endpoint)
      }

      const tunnel = server.createPairingOffer({
        address: 'tunnel.example.com:443',
        name: 'Tunnel test'
      })
      expect(tunnel.available).toBe(true)
      if (tunnel.available) {
        expect(tunnel.endpoint).toBe('ws://tunnel.example.com:443')
      }

      const fullUrl = server.createPairingOffer({
        address: 'wss://runtime.example.com/orca',
        name: 'Full URL test'
      })
      expect(fullUrl.available).toBe(true)
      if (fullUrl.available) {
        expect(fullUrl.endpoint).toBe('wss://runtime.example.com/orca')
      }
    } finally {
      await server.stop()
    }
  })

  it('creates mobile-scoped pairing offers for headless mobile pairing', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()

    try {
      const offer = server.createPairingOffer({
        address: '100.64.1.20',
        name: 'Mobile test',
        scope: 'mobile'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }

      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)?.scope).toBe('mobile')
      const parsed = parsePairingCode(offer.pairingUrl)
      expect(parsed?.endpoint).toBe(offer.endpoint)
      expect(parsed?.endpoint).toContain('100.64.1.20')
    } finally {
      await server.stop()
    }
  })

  it('cleans up pre-auth E2EE WebSocket state when the socket closes', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()

    try {
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        name: 'mobile-test',
        scope: 'mobile'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const parsed = parsePairingCode(offer.pairingUrl)!
      const ws = await connectWs(parsed.endpoint)
      const mobileKeys = generateKeyPair()
      ws.send(
        JSON.stringify({
          type: 'e2ee_hello',
          publicKeyB64: Buffer.from(mobileKeys.publicKey).toString('base64')
        })
      )
      expect(JSON.parse(await nextWsMessage(ws))).toEqual({ type: 'e2ee_ready' })
      expect(server['e2eeChannels'].size).toBe(1)
      expect(server['wsConnectionIds'].size).toBe(1)

      ws.close()
      await waitForWsClose(ws)
      await waitFor(() => server['e2eeChannels'].size === 0 && server['wsConnectionIds'].size === 0)
    } finally {
      await server.stop()
    }
  })

  it('terminates active WebSockets for a revoked mobile device', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    const disconnectSpy = vi.spyOn(runtime, 'onClientDisconnected')

    await server.start()

    try {
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        name: 'mobile-test',
        scope: 'mobile'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }
      const first = await authenticateMobileWs(offer.pairingUrl)
      const second = await authenticateMobileWs(offer.pairingUrl)

      expect(server.revokeMobileDevice(offer.deviceId)).toBe(true)
      await Promise.all([waitForWsClose(first), waitForWsClose(second)])
      await waitFor(() => server['e2eeChannels'].size === 0 && server['wsConnectionIds'].size === 0)

      expect(disconnectSpy).toHaveBeenCalledTimes(1)
    } finally {
      disconnectSpy.mockRestore()
      await server.stop()
    }
  })

  it('does not revoke runtime-scoped devices through mobile revocation', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()

    try {
      const offer = server.createPairingOffer({
        address: '127.0.0.1',
        name: 'runtime-test',
        scope: 'runtime'
      })
      expect(offer.available).toBe(true)
      if (!offer.available) {
        throw new Error('WebSocket pairing unavailable')
      }

      expect(server.revokeMobileDevice(offer.deviceId)).toBe(false)
      expect(server.getDeviceRegistry()?.getDevice(offer.deviceId)?.scope).toBe('runtime')
    } finally {
      await server.stop()
    }
  })

  it('caps WebSocket long-polls and aborts them when the socket closes', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      enableWebSocket: false,
      longPollCap: 1
    })
    const device = server['deviceRegistry'] ?? null
    expect(device).toBeNull()
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const entry = server['deviceRegistry']!.addDevice('runtime-test', 'runtime')
    const ws = new FakeWebSocket()
    server['wsConnectionIds'].set(ws as unknown as WebSocket, 'conn-test')
    const replies: Record<string, unknown>[] = []

    try {
      const first = server['handleWebSocketMessage'](
        JSON.stringify({
          id: 'req_wait',
          method: 'orchestration.check',
          deviceToken: entry.token,
          params: { terminal: 'term_wait', wait: true, timeoutMs: 10_000 }
        }),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        ws as unknown as WebSocket
      )

      await waitFor(() => server['activeLongPolls'] === 1)

      await server['handleWebSocketMessage'](
        JSON.stringify({
          id: 'req_busy',
          method: 'orchestration.check',
          deviceToken: entry.token,
          params: { terminal: 'term_busy', wait: true, timeoutMs: 10_000 }
        }),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        ws as unknown as WebSocket
      )

      expect(replies).toContainEqual(
        expect.objectContaining({
          id: 'req_busy',
          ok: false,
          error: expect.objectContaining({ code: 'runtime_busy' })
        })
      )
      expect(server['activeLongPolls']).toBe(1)

      ws.readyState = 3
      ws.emit('close')
      await first

      expect(server['activeLongPolls']).toBe(0)
      expect(replies).toContainEqual(expect.objectContaining({ id: 'req_wait', ok: true }))
    } finally {
      db.close()
      await server.stop()
    }
  })

  it('limits mobile-scoped WebSocket tokens to the mobile RPC surface', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const pushRuntimeGit = vi.fn().mockResolvedValue({ ok: true })
    const selectClaudeAccount = vi.fn().mockResolvedValue({ ok: true })
    const selectCodexAccount = vi.fn().mockResolvedValue({ ok: true })
    const removeClaudeAccount = vi.fn().mockResolvedValue({ ok: true })
    const readTerminal = vi.fn().mockResolvedValue({ tail: ['ok'] })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getStatus: vi.fn().mockResolvedValue({ graphStatus: 'ok' }),
      pushRuntimeGit,
      selectClaudeAccount,
      selectCodexAccount,
      removeClaudeAccount,
      readTerminal
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const mobile = server['deviceRegistry']!.addDevice('phone', 'mobile')
    const replies: Record<string, unknown>[] = []

    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_forbidden',
        method: 'git.push',
        deviceToken: mobile.token,
        params: { worktree: 'id:wt-1' }
      }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {}
    )
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_allowed',
        method: 'status.get',
        deviceToken: mobile.token
      }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {}
    )
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_select_claude',
        method: 'accounts.selectClaude',
        deviceToken: mobile.token,
        params: { accountId: 'claude-account' }
      }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {}
    )
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_select_codex',
        method: 'accounts.selectCodex',
        deviceToken: mobile.token,
        params: { accountId: null }
      }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {}
    )
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_remove_claude',
        method: 'accounts.removeClaude',
        deviceToken: mobile.token,
        params: { accountId: 'claude-account' }
      }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {}
    )
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_terminal_read',
        method: 'terminal.read',
        deviceToken: mobile.token,
        params: { terminal: 'term-1' }
      }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {}
    )

    expect(replies).toContainEqual(
      expect.objectContaining({
        id: 'req_forbidden',
        ok: false,
        error: expect.objectContaining({ code: 'forbidden' })
      })
    )
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_allowed', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_select_claude', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_select_codex', ok: true }))
    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_terminal_read', ok: true }))
    expect(replies).toContainEqual(
      expect.objectContaining({
        id: 'req_remove_claude',
        ok: false,
        error: expect.objectContaining({ code: 'forbidden' })
      })
    )
    expect(selectClaudeAccount).toHaveBeenCalledWith('claude-account')
    expect(selectCodexAccount).toHaveBeenCalledWith(null)
    expect(readTerminal).toHaveBeenCalledWith('term-1', { cursor: undefined })
    expect(removeClaudeAccount).not.toHaveBeenCalled()
    expect(pushRuntimeGit).not.toHaveBeenCalled()
  })

  it('allows runtime-scoped WebSocket tokens to use the full RPC surface', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const pushRuntimeGit = vi.fn().mockResolvedValue({ ok: true })
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      pushRuntimeGit
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const runtimeDevice = server['deviceRegistry']!.addDevice('cli', 'runtime')
    const replies: Record<string, unknown>[] = []

    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_push',
        method: 'git.push',
        deviceToken: runtimeDevice.token,
        params: { worktree: 'id:wt-1' }
      }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {}
    )

    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_push', ok: true }))
    expect(pushRuntimeGit).toHaveBeenCalledWith('id:wt-1', undefined, undefined)
  })

  it('leaves the last published metadata in place when a runtime stops', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      pid: 1001
    })

    await server.start()
    const metadata = readRuntimeMetadata(userDataPath)
    expect(metadata?.pid).toBe(1001)

    await server.stop()
    expect(readRuntimeMetadata(userDataPath)).toMatchObject({
      pid: 1001,
      runtimeId: runtime.getRuntimeId()
    })
  })

  it('closes the socket if metadata publication fails during startup', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    const writeMetadataSpy = vi
      .spyOn(runtimeMetadataModule, 'writeRuntimeMetadata')
      .mockImplementationOnce(() => {
        throw new Error('write failed')
      })
    const endpoint = createRuntimeTransportMetadata(
      userDataPath,
      process.pid,
      process.platform,
      runtime.getRuntimeId()
    ).endpoint

    await expect(server.start()).rejects.toThrow('write failed')
    expect(readRuntimeMetadata(userDataPath)).toBeNull()
    expect(existsSync(endpoint)).toBe(false)
    expect(server['transports']).toEqual([])
    expect(server['activeTransports']).toEqual([])

    writeMetadataSpy.mockRestore()
  })

  it('serves status.get for authenticated callers', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const response = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_1',
      authToken: metadata!.authToken,
      method: 'status.get'
    })

    expect(response).toMatchObject({
      id: 'req_1',
      ok: true,
      _meta: {
        runtimeId: runtime.getRuntimeId()
      }
    })
    expect((response.result as { graphStatus: string }).graphStatus).toBe('unavailable')

    await server.stop()
  })

  it('rejects requests with the wrong auth token', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const response = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_1',
      authToken: 'wrong',
      method: 'status.get'
    })

    expect(response).toMatchObject({
      id: 'req_1',
      ok: false,
      error: {
        code: 'unauthorized'
      }
    })

    await server.stop()
  })

  it('rejects malformed requests before dispatch', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const response = await sendRequest(metadata!.transports[0]!.endpoint, {
      authToken: metadata!.authToken,
      method: 'status.get'
    })

    expect(response).toMatchObject({
      id: 'unknown',
      ok: false,
      error: {
        code: 'bad_request'
      }
    })

    await server.stop()
  })

  it('serves terminal.list and terminal.show for live runtime terminals', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const writes: string[] = []
    runtime.setPtyController({
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'hello\n', 123)

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const listResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_list',
      authToken: metadata!.authToken,
      method: 'terminal.list',
      params: {
        worktree: 'id:repo-1::/tmp/worktree-a'
      }
    })
    expect(listResponse).toMatchObject({
      id: 'req_list',
      ok: true
    })

    const handle = (
      (
        listResponse.result as {
          terminals: { handle: string }[]
          totalCount: number
          truncated: boolean
        }
      ).terminals[0] ?? { handle: '' }
    ).handle
    expect(handle).toBeTruthy()

    const showResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_show',
      authToken: metadata!.authToken,
      method: 'terminal.show',
      params: {
        terminal: handle
      }
    })
    expect(showResponse).toMatchObject({
      id: 'req_show',
      ok: true
    })

    const readResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_read',
      authToken: metadata!.authToken,
      method: 'terminal.read',
      params: {
        terminal: handle
      }
    })
    expect(readResponse).toMatchObject({
      id: 'req_read',
      ok: true
    })

    const sendResponse = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_send',
      authToken: metadata!.authToken,
      method: 'terminal.send',
      params: {
        terminal: handle,
        text: 'continue',
        enter: true
      }
    })
    expect(sendResponse).toMatchObject({
      id: 'req_send',
      ok: true
    })
    expect(writes).toEqual(['continue', '\r'])

    const waitPromise = sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_wait',
      authToken: metadata!.authToken,
      method: 'terminal.wait',
      params: {
        terminal: handle,
        for: 'exit',
        timeoutMs: 1000
      }
    })
    runtime.onPtyExit('pty-1', 9)
    const waitResponse = await waitPromise
    expect(waitResponse).toMatchObject({
      id: 'req_wait',
      ok: true,
      result: {
        wait: {
          handle,
          condition: 'exit',
          satisfied: true,
          status: 'exited',
          exitCode: 9
        }
      }
    })

    await server.stop()
  })

  it('serves worktree.ps from the runtime summary builder', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService(makeStore({ isUnread: true }) as never)
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          title: 'Claude',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: 'repo-1::/tmp/worktree-a',
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })
    runtime.onPtyData('pty-1', 'hello\n', 555)

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const response = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_ps',
      authToken: metadata!.authToken,
      method: 'worktree.ps'
    })

    expect(response).toMatchObject({
      id: 'req_ps',
      ok: true,
      result: {
        worktrees: [
          {
            worktreeId: 'repo-1::/tmp/worktree-a',
            repoId: 'repo-1',
            repo: 'repo',
            path: '/tmp/worktree-a',
            branch: 'feature/foo',
            linkedIssue: 123,
            unread: true,
            liveTerminalCount: 1,
            hasAttachedPty: true,
            lastOutputAt: 555,
            preview: 'hello'
          }
        ],
        totalCount: 1,
        truncated: false
      }
    })

    await server.stop()
  })

  it('bounds worktree.list responses with limit metadata', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService(makeStore({ isUnread: true }) as never)
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const response = await sendRequest(metadata!.transports[0]!.endpoint, {
      id: 'req_worktrees',
      authToken: metadata!.authToken,
      method: 'worktree.list',
      params: {
        limit: 1
      }
    })

    expect(response).toMatchObject({
      id: 'req_worktrees',
      ok: true,
      result: {
        totalCount: 1,
        truncated: false
      }
    })

    await server.stop()
  })

  it('rejects oversized RPC frames instead of buffering them indefinitely', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const socket = createConnection(metadata!.transports[0]!.endpoint)
      let buffer = ''
      socket.setEncoding('utf8')
      socket.once('error', reject)
      socket.on('data', (chunk) => {
        buffer += chunk
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex === -1) {
          return
        }
        socket.end()
        resolve(JSON.parse(buffer.slice(0, newlineIndex)) as Record<string, unknown>)
      })
      socket.on('connect', () => {
        socket.write(`${'x'.repeat(1024 * 1024 + 1)}\n`)
      })
    })

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'request_too_large'
      }
    })

    await server.stop()
  })

  // Why: §6 tests for the transport keepalive + long-poll counter path in §3.1.
  // Exercise the real socket (not a mock) so we catch buffer/flush regressions
  // that a unit-level test would miss.
  describe('long-poll transport (§3.1)', () => {
    it('emits keepalive frames while a check --wait handler blocks', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      // Why: 50ms keepalive lets us collect ≥3 frames within a 300ms wait
      // window without slowing the suite.
      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 50
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const session = openFramedSession(metadata!.transports[0]!.endpoint, {
          id: 'req_wait',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: {
            terminal: 'term_nobody',
            wait: true,
            timeoutMs: 300
          }
        })
        await session.done

        const keepalives = session.frames.filter((f) => f._keepalive === true)
        const terminals = session.frames.filter((f) => f.ok !== undefined)
        expect(terminals).toHaveLength(1)
        expect(terminals[0]).toMatchObject({ id: 'req_wait', ok: true })
        // Why: 300ms wait with 50ms keepalive → expect roughly 5 keepalives;
        // assert ≥3 to tolerate scheduler jitter without flaking.
        expect(keepalives.length).toBeGreaterThanOrEqual(3)
      } finally {
        db.close()
        await server.stop()
      }
    })

    it('releases long-poll slot when client closes mid-wait', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 1000,
        longPollCap: 2
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const endpoint = metadata!.transports[0]!.endpoint

        // Fill the cap with two long waits (10s each — we'll kill them).
        const a = openFramedSession(endpoint, {
          id: 'req_a',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_a', wait: true, timeoutMs: 10_000 }
        })
        const b = openFramedSession(endpoint, {
          id: 'req_b',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_b', wait: true, timeoutMs: 10_000 }
        })
        // Let the two waits land in the handler and increment the counter.
        await sleep(100)
        expect(server['activeLongPolls']).toBe(2)

        // Kill one client mid-wait; counter must drop to 1.
        a.socket.destroy()
        await a.done
        // Give Node one tick to fire the close event on the server socket.
        await sleep(50)
        expect(server['activeLongPolls']).toBe(1)

        // The freed slot must admit a new long-poll immediately.
        const c = openFramedSession(endpoint, {
          id: 'req_c',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_c', wait: true, timeoutMs: 100 }
        })
        await c.done
        const cTerminal = c.frames.find((f) => f.ok !== undefined)
        expect(cTerminal).toMatchObject({ ok: true, id: 'req_c' })

        b.socket.destroy()
        await b.done
      } finally {
        db.close()
        await server.stop()
      }
    })

    it('responds runtime_busy once the long-poll cap is saturated', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const db = new OrchestrationDb(':memory:')
      runtime.setOrchestrationDb(db)
      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 1000,
        longPollCap: 1
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const endpoint = metadata!.transports[0]!.endpoint

        const a = openFramedSession(endpoint, {
          id: 'req_a',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_a', wait: true, timeoutMs: 5_000 }
        })
        await sleep(100)
        expect(server['activeLongPolls']).toBe(1)

        // Second long-poll overflows the cap → runtime_busy.
        const overflow = await sendRequest(endpoint, {
          id: 'req_overflow',
          authToken: metadata!.authToken,
          method: 'orchestration.check',
          params: { terminal: 'term_b', wait: true, timeoutMs: 5_000 }
        })
        expect(overflow).toMatchObject({
          id: 'req_overflow',
          ok: false,
          error: { code: 'runtime_busy' }
        })
        // The failing request must not have counted against the cap.
        expect(server['activeLongPolls']).toBe(1)

        // Short RPCs still succeed even when the long-poll cap is full.
        const short = await sendRequest(endpoint, {
          id: 'req_short',
          authToken: metadata!.authToken,
          method: 'status.get'
        })
        expect(short).toMatchObject({ id: 'req_short', ok: true })

        a.socket.destroy()
        await a.done
      } finally {
        db.close()
        await server.stop()
      }
    })

    it('does not emit keepalive frames for short RPCs', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      // Why: a 10ms interval means any frame in the first ~100ms of a short
      // RPC would show up; `status.get` returns in <10ms so no keepalive
      // should ever fire. Locks in the "keepalive is long-poll-only" invariant
      // so a future refactor can't silently re-broaden the timer.
      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath,
        keepaliveIntervalMs: 10
      })
      await server.start()

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const session = openFramedSession(metadata!.transports[0]!.endpoint, {
          id: 'req_short',
          authToken: metadata!.authToken,
          method: 'status.get'
        })
        await session.done

        const keepalives = session.frames.filter((f) => f._keepalive === true)
        const terminals = session.frames.filter((f) => f.ok !== undefined)
        expect(terminals).toHaveLength(1)
        expect(terminals[0]).toMatchObject({ id: 'req_short', ok: true })
        expect(keepalives).toHaveLength(0)
      } finally {
        await server.stop()
      }
    })

    it('returns an internal_error envelope when the dispatcher throws', async () => {
      // Why: handlers are designed to return error envelopes, never to throw,
      // but a bug somewhere in the RPC stack (e.g. JSON.stringify choking on
      // a response with circular refs) must still produce a terminal frame.
      // Without the `.catch` on handleMessage's promise, a throw would leave
      // the client hanging until the 30s idle timer and leak the dispatch's
      // AbortController in the transport's in-flight set.
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      const runtime = new OrcaRuntimeService()
      const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
      await server.start()

      // Force the dispatcher to throw a non-envelope error.
      const originalDispatch = server['dispatcher'].dispatch.bind(server['dispatcher'])
      server['dispatcher'].dispatch = vi.fn().mockRejectedValue(new Error('boom'))

      try {
        const metadata = readRuntimeMetadata(userDataPath)
        const response = await sendRequest(metadata!.transports[0]!.endpoint, {
          id: 'req_throw',
          authToken: metadata!.authToken,
          method: 'status.get'
        })
        expect(response).toMatchObject({
          id: 'req_throw',
          ok: false,
          error: { code: 'internal_error', message: 'boom' }
        })
      } finally {
        server['dispatcher'].dispatch = originalDispatch
        await server.stop()
      }
    })
  })

  // Why: §6 test for the idempotent + hard-fail schema migration. A broken
  // migration must crash startup loudly rather than serve traffic against a
  // schema missing the delivered_at column.
  describe('orchestration DB migration (§3.2)', () => {
    it('is idempotent when delivered_at already exists', () => {
      // First open creates the column; second open should be a no-op.
      const db1 = new OrchestrationDb(':memory:')
      db1.close()
      // File path reuse is meaningless with :memory:, so use a tmp file.
      const tmpPath = join(mkdtempSync(join(tmpdir(), 'orca-orch-mig-')), 'orch.sqlite')
      const a = new OrchestrationDb(tmpPath)
      a.close()
      // Second construction must not throw "duplicate column name".
      expect(() => {
        const b = new OrchestrationDb(tmpPath)
        b.close()
      }).not.toThrow()
    })

    it('hard-fails startup when the migration cannot be applied', () => {
      // Simulate a migration error by monkey-patching better-sqlite3's exec.
      // If ALTER TABLE throws for any reason (e.g. disk full, permissions),
      // the constructor must propagate — not swallow and serve half-broken.
      //
      // Why the pre-seeded v2 DB: after the schema bundle, fresh DBs are
      // initialized directly at v3 via createTables() (which already includes
      // `delivered_at`), so the v2 → v3 ALTER is a no-op for new installs.
      // To exercise the hard-fail path we need a DB that actually has work
      // to migrate — a v2-shape file without the delivered_at column — so
      // the guarded ALTER runs and the stub can fire.
      const tmpPath = join(mkdtempSync(join(tmpdir(), 'orca-orch-mig-')), 'orch.sqlite')
      const seed = new Database(tmpPath)
      seed.exec(`
        CREATE TABLE messages (
          id            TEXT NOT NULL,
          from_handle   TEXT NOT NULL,
          to_handle     TEXT NOT NULL,
          subject       TEXT NOT NULL,
          body          TEXT NOT NULL DEFAULT '',
          type          TEXT NOT NULL DEFAULT 'status'
            CHECK(type IN (
              'status', 'dispatch', 'worker_done', 'merge_ready',
              'escalation', 'handoff', 'decision_gate', 'heartbeat'
            )),
          priority      TEXT NOT NULL DEFAULT 'normal'
            CHECK(priority IN ('normal', 'high', 'urgent')),
          thread_id     TEXT,
          payload       TEXT,
          read          INTEGER NOT NULL DEFAULT 0,
          sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
      seed.pragma('user_version = 2')
      seed.close()

      const realPrototype = Database.prototype as unknown as {
        exec: (sql: string) => unknown
      }
      const originalExec = realPrototype.exec
      realPrototype.exec = function (sql: string) {
        if (sql.includes('ALTER TABLE messages ADD COLUMN delivered_at')) {
          throw new Error('simulated migration failure')
        }
        return originalExec.call(this, sql)
      }
      try {
        expect(() => new OrchestrationDb(tmpPath)).toThrow('simulated migration failure')
      } finally {
        realPrototype.exec = originalExec
      }
    })
  })
})
