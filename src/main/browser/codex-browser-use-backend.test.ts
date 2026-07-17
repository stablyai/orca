import { afterEach, describe, expect, it, vi } from 'vitest'
import { connect, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CodexBrowserUseBackend } from './codex-browser-use-backend'
import {
  defaultCodexBrowserUseSocketPath,
  type CodexBrowserUseAdapter
} from './codex-browser-use-protocol'

type RpcResponse = { id: number; result?: unknown; error?: { message: string } }

async function rpc(socketPath: string, method: string, params: object): Promise<RpcResponse> {
  const socket = connect(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const response = await rpcOnSocket(socket, 1, method, params)
  socket.end()
  return response
}

async function rpcOnSocket(
  socket: Socket,
  id: number,
  method: string,
  params: object
): Promise<RpcResponse> {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  const frame = Buffer.allocUnsafe(body.length + 4)
  frame.writeUInt32LE(body.length, 0)
  body.copy(frame, 4)
  socket.write(frame)

  const response = await new Promise<RpcResponse>((resolve, reject) => {
    let pending = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)])
      if (pending.length < 4) {
        return
      }
      const length = pending.readUInt32LE(0)
      if (pending.length < length + 4) {
        return
      }
      const parsed = JSON.parse(pending.subarray(4, length + 4).toString('utf8')) as RpcResponse
      if (parsed.id === id) {
        resolve(parsed)
      }
    })
    socket.once('error', reject)
  })
  return response
}

function testAdapter(overrides: Partial<CodexBrowserUseAdapter> = {}): CodexBrowserUseAdapter {
  return {
    resolveWorktreeId: vi.fn((sessionId) => (sessionId === 'codex-session' ? 'worktree-1' : null)),
    listTabs: vi.fn(() => [
      { browserPageId: 'page-a', url: 'https://example.com', title: 'Example', active: true }
    ]),
    attach: vi.fn(),
    detach: vi.fn(),
    executeCdp: vi.fn(),
    ...overrides
  }
}

describe('CodexBrowserUseBackend', () => {
  let service: CodexBrowserUseBackend | undefined
  let tempDirectory: string | undefined

  afterEach(async () => {
    await service?.stop()
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  it('uses the fixed POSIX directory scanned by the Browser plugin', () => {
    expect(defaultCodexBrowserUseSocketPath('darwin', 42)).toBe(
      '/tmp/codex-browser-use/orca-42.sock'
    )
    expect(defaultCodexBrowserUseSocketPath('linux', 42)).toBe(
      '/tmp/codex-browser-use/orca-42.sock'
    )
  })

  it('advertises only the worktree owned by the requesting Codex session', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'orca-iab-test-'))
    const socketPath = join(tempDirectory, 'backend.sock')
    const adapter = testAdapter()
    service = new CodexBrowserUseBackend(adapter, { socketPath })
    await service.start()

    const info = await rpc(socketPath, 'getInfo', {
      session_id: 'codex-session',
      turn_id: 'turn-1',
      session_context: 'live'
    })
    expect(info.result).toMatchObject({
      type: 'iab',
      metadata: {
        codexSessionId: 'codex-session',
        codexAppBuildFlavor: 'prod'
      },
      apiSupportOverrides: {
        'Browser.nameSession': false,
        'ContentAPI.export': false,
        'Tabs.new': false
      }
    })

    const tabs = await rpc(socketPath, 'getTabs', {
      session_id: 'codex-session',
      turn_id: 'turn-1',
      session_context: 'live'
    })
    expect(tabs.result).toEqual([
      { id: 1, url: 'https://example.com', title: 'Example', active: true }
    ])
    expect(adapter.listTabs).toHaveBeenCalledWith('worktree-1')
  })

  it('rejects a session that is not owned by an Orca pane', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'orca-iab-test-'))
    const socketPath = join(tempDirectory, 'backend.sock')
    const adapter: CodexBrowserUseAdapter = {
      resolveWorktreeId: () => null,
      listTabs: vi.fn(),
      attach: vi.fn(),
      detach: vi.fn(),
      executeCdp: vi.fn()
    }
    service = new CodexBrowserUseBackend(adapter, { socketPath })
    await service.start()

    const response = await rpc(socketPath, 'getInfo', {
      session_id: 'unknown-session',
      turn_id: 'turn-1',
      session_context: 'live'
    })
    expect(response.error?.message).toContain('not associated with an Orca workspace')
  })

  it('does not allow one socket connection to switch Codex sessions', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'orca-iab-test-'))
    const socketPath = join(tempDirectory, 'backend.sock')
    const adapter = testAdapter({ resolveWorktreeId: vi.fn(() => 'worktree-1') })
    service = new CodexBrowserUseBackend(adapter, { socketPath })
    await service.start()
    const socket = connect(socketPath)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', reject)
    })

    expect(
      (
        await rpcOnSocket(socket, 1, 'getInfo', {
          session_id: 'codex-session',
          turn_id: 'turn-1'
        })
      ).error
    ).toBeUndefined()
    const switched = await rpcOnSocket(socket, 2, 'getInfo', {
      session_id: 'other-session',
      turn_id: 'turn-2'
    })
    expect(switched.error?.message).toContain('cannot change Codex sessions')
    socket.end()
  })

  it('routes CDP execution to the tab owned by the requesting session', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'orca-iab-test-'))
    const socketPath = join(tempDirectory, 'backend.sock')
    const executeCdp = vi.fn(() => ({ result: { value: 'Example Domain' } }))
    const adapter = testAdapter({ executeCdp })
    service = new CodexBrowserUseBackend(adapter, { socketPath })
    await service.start()

    const response = await rpc(socketPath, 'executeCdp', {
      session_id: 'codex-session',
      turn_id: 'turn-1',
      target: { tabId: 1, sessionId: 'cdp-session' },
      method: 'Runtime.evaluate',
      commandParams: { expression: 'document.title' }
    })
    expect(response.result).toEqual({ result: { value: 'Example Domain' } })
    expect(executeCdp).toHaveBeenCalledWith(
      expect.any(String),
      'codex-session',
      'worktree-1',
      'page-a',
      { tabId: 1, sessionId: 'cdp-session' },
      'Runtime.evaluate',
      { expression: 'document.title' }
    )
  })

  it('releases an attached CDP connection and assigns a fresh owner after reconnect', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'orca-iab-test-'))
    const socketPath = join(tempDirectory, 'backend.sock')
    const attach = vi.fn()
    const detach = vi.fn()
    const adapter = testAdapter({ attach, detach })
    service = new CodexBrowserUseBackend(adapter, { socketPath })
    await service.start()

    const connectAndAttach = async (requestId: number): Promise<Socket> => {
      const socket = connect(socketPath)
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      await rpcOnSocket(socket, requestId, 'getTabs', {
        session_id: 'codex-session',
        turn_id: `turn-${requestId}`
      })
      await rpcOnSocket(socket, requestId + 1, 'attach', {
        session_id: 'codex-session',
        turn_id: `turn-${requestId}`,
        tabId: 1
      })
      return socket
    }

    const firstSocket = await connectAndAttach(10)
    const firstOwner = attach.mock.calls[0]?.[0]
    firstSocket.end()
    await vi.waitFor(() =>
      expect(detach).toHaveBeenCalledWith(firstOwner, 'codex-session', 'worktree-1', 'page-a')
    )

    const secondSocket = await connectAndAttach(20)
    const secondOwner = attach.mock.calls[1]?.[0]
    expect(secondOwner).not.toBe(firstOwner)
    secondSocket.end()
  })

  it('retires a closed tab id and assigns a new id after tab replacement', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'orca-iab-test-'))
    const socketPath = join(tempDirectory, 'backend.sock')
    const listTabs = vi
      .fn()
      .mockReturnValueOnce([
        { browserPageId: 'page-a', url: 'https://old.example', title: 'Old', active: true }
      ])
      .mockReturnValue([
        { browserPageId: 'page-b', url: 'https://new.example', title: 'New', active: true }
      ])
    const adapter = testAdapter({ listTabs })
    service = new CodexBrowserUseBackend(adapter, { socketPath })
    await service.start()

    const first = await rpc(socketPath, 'getTabs', {
      session_id: 'codex-session',
      turn_id: 'turn-1'
    })
    const second = await rpc(socketPath, 'getTabs', {
      session_id: 'codex-session',
      turn_id: 'turn-2'
    })
    expect(first.result).toEqual([
      { id: 1, url: 'https://old.example', title: 'Old', active: true }
    ])
    expect(second.result).toEqual([
      { id: 2, url: 'https://new.example', title: 'New', active: true }
    ])
  })
})
