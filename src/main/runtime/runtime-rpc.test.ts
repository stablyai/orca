/* eslint-disable max-lines -- Why: this integration-style RPC test keeps the request/response contract together so regressions in the external CLI surface are easier to spot. */
import { existsSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createConnection } from 'net'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import * as runtimeMetadataModule from './runtime-metadata'
import { readRuntimeMetadata } from './runtime-metadata'
import { createRuntimeTransportMetadata, OrcaRuntimeRpcServer } from './runtime-rpc'

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
        isArchived: false,
        isUnread: overrides?.isUnread ?? false,
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
    expect(metadata?.transport?.endpoint).toBeTruthy()
    expect(metadata?.transport).toEqual(server['transport'])

    await server.stop()
    expect(readRuntimeMetadata(userDataPath)).toMatchObject({
      runtimeId: runtime.getRuntimeId()
    })
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
    expect(server['transport']).toBeNull()
    expect(server['server']).toBeNull()

    writeMetadataSpy.mockRestore()
  })

  it('serves status.get for authenticated callers', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const response = await sendRequest(metadata!.transport!.endpoint, {
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
    const response = await sendRequest(metadata!.transport!.endpoint, {
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
    const response = await sendRequest(metadata!.transport!.endpoint, {
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
      kill: () => true
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
    const listResponse = await sendRequest(metadata!.transport!.endpoint, {
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

    const showResponse = await sendRequest(metadata!.transport!.endpoint, {
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

    const readResponse = await sendRequest(metadata!.transport!.endpoint, {
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

    const sendResponse = await sendRequest(metadata!.transport!.endpoint, {
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
    expect(writes).toEqual(['continue\r'])

    const waitPromise = sendRequest(metadata!.transport!.endpoint, {
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
    const response = await sendRequest(metadata!.transport!.endpoint, {
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
    const response = await sendRequest(metadata!.transport!.endpoint, {
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
      const socket = createConnection(metadata!.transport!.endpoint)
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
})
