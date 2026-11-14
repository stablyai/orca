import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sendRequest } from './transport'
import { RuntimeClient } from '../client'
import { getRuntimeMetadataPath } from '../../../shared/runtime-bootstrap'
import { requestWorktreeRemoval } from '../../workspaces/worktree-removal-request'

const roots: string[] = []
const servers = new Set<ReturnType<typeof createServer>>()
const sockets = new Set<Socket>()

afterEach(async () => {
  vi.useRealTimers()
  vi.clearAllMocks()
  for (const socket of sockets) {
    socket.destroy()
  }
  sockets.clear()
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  servers.clear()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

// These fixtures create Unix domain sockets rather than Windows named pipes.
describe.skipIf(process.platform === 'win32')('runtime transport', () => {
  it.each(['preflight', 'mutation'] as const)(
    'reports a timeout during %s truthfully',
    async (phase) => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-removal-timeout-'))
      roots.push(directory)
      const endpoint = join(directory, 'runtime.sock')
      const received = Promise.withResolvers<void>()
      const methods: string[] = []
      const server = createServer((socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
        socket.on('data', (data) => {
          const request = JSON.parse(String(data).trim())
          methods.push(request.method)
          if (phase === 'mutation' && request.method === 'status.get') {
            socket.write(
              `${JSON.stringify({
                id: request.id,
                ok: true,
                result: { capabilities: ['worktree.remove-branch-policy.v1'] },
                _meta: { runtimeId: 'timeout' }
              })}\n`
            )
          } else {
            received.resolve()
          }
        })
      })
      servers.add(server)
      await new Promise<void>((resolve) => server.listen(endpoint, resolve))
      writeFileSync(
        getRuntimeMetadataPath(directory),
        JSON.stringify({
          runtimeId: 'timeout',
          pid: process.pid,
          transports: [{ kind: 'unix', endpoint }],
          authToken: 'test',
          startedAt: 1
        })
      )
      const client = new RuntimeClient(directory, 5000, null, null)
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const response = requestWorktreeRemoval(client, {
        worktree: 'id:task',
        hostId: 'local',
        force: false,
        deleteBranch: false,
        runHooks: false,
        allowFailedArchiveHook: false
      }).catch((error: unknown) => error)
      await received.promise
      await vi.runAllTimersAsync()
      expect(await response).toMatchObject({
        code: phase === 'preflight' ? 'runtime_timeout' : 'worktree_removal_in_progress'
      })
      expect(methods).toEqual(
        phase === 'preflight' ? ['status.get'] : ['status.get', 'worktree.rm']
      )
    }
  )

  it.each([
    'capable',
    'absent',
    'empty',
    'unrelated',
    'malformed',
    'error',
    'close',
    'after-send',
    'prepare'
  ] as const)('selects the local wire request without replay: %s', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'orca-selection-'))
    roots.push(root)
    const endpoint = join(root, 'runtime.sock')
    const requests: { id: string; method: string; params?: unknown }[] = []
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('data', (data) => {
        const request: { id: string; method: string; params?: unknown } = JSON.parse(
          String(data).trim()
        )
        requests.push(request)
        if (mode === 'close' || (mode === 'after-send' && request.method === 'worktree.rm')) {
          socket.end()
          return
        }
        socket.write(
          `${JSON.stringify({
            id: request.id,
            ok: mode !== 'error',
            ...(mode === 'error'
              ? { error: { code: 'failed', message: 'status failed' } }
              : {
                  result:
                    request.method === 'worktree.rm'
                      ? { removed: true }
                      : mode === 'capable'
                        ? { capabilities: ['worktree.remove-branch-policy.v1'] }
                        : mode === 'empty'
                          ? { capabilities: [] }
                          : mode === 'unrelated'
                            ? { capabilities: ['future'] }
                            : mode === 'malformed'
                              ? { capabilities: 42 }
                              : {}
                }),
            _meta: { runtimeId: 'selection' }
          })}\n`
        )
      })
    })
    servers.add(server)
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    writeFileSync(
      getRuntimeMetadataPath(root),
      JSON.stringify({
        runtimeId: 'selection',
        pid: process.pid,
        transports: [{ kind: 'unix', endpoint }],
        authToken: 'test',
        startedAt: 1
      })
    )
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {})
    const selected = {
      worktree: 'id:task',
      hostId: 'local',
      force: false,
      runHooks: false,
      allowFailedArchiveHook: false
    }
    try {
      if (mode === 'prepare') {
        const dispatched = vi.fn()
        await expect(
          sendRequest(
            {
              runtimeId: 'selection',
              pid: process.pid,
              transports: [{ kind: 'unix', endpoint }],
              authToken: 'test',
              startedAt: 1
            },
            'worktree.rm',
            {},
            5000,
            undefined,
            undefined,
            { requestSelection: { paramsForStatus: () => ({ value: 1n }), onDispatch: dispatched } }
          )
        ).rejects.toThrow()
      } else {
        const promise = requestWorktreeRemoval(new RuntimeClient(root, 5000, null, null), {
          ...selected,
          deleteBranch: false
        })
        await (['capable', 'absent', 'empty', 'unrelated'].includes(mode)
          ? expect(promise).resolves.toMatchObject({ result: { removed: true } })
          : expect(promise).rejects.toBeInstanceOf(Error))
      }
      const sent = ['capable', 'absent', 'empty', 'unrelated', 'after-send'].includes(mode)
      expect(requests.map((request) => request.method)).toEqual(
        sent ? ['status.get', 'worktree.rm'] : ['status.get']
      )
      if (sent) {
        expect(requests[1].params).toEqual({
          ...selected,
          allowUnverifiedPtyStop: false,
          waitForBackgroundRemoval: true,
          ...(mode === 'capable' ? { deleteBranch: false } : {})
        })
      }
    } finally {
      warning.mockRestore()
    }
  })
})
