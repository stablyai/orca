import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeWorktreeAndWait } from './handlers/worktree-removal-outcome'
import { RuntimeClient } from './runtime-client'

const REMOVALS = 50
// The host's local socket limit (MAX_RUNTIME_RPC_CONNECTIONS); past it, Node closes a connection
// the client already wrote to, unread.
const HOST_CONNECTION_LIMIT = 32

const RequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  params: z.object({ worktreeId: z.string().optional(), worktree: z.string().optional() })
})

// Why a stand-in host: the drop under test is the socket's, and only a real socket produces it.
function startHost(
  endpoint: string
): Promise<{ accepted: Map<string, number>; close: () => void }> {
  const accepted = new Map<string, number>()
  const readsAfterAccept = new Map<string, number>()
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    socket.once('data', (data: string) => {
      const request = RequestSchema.parse(JSON.parse(data.trim()))
      let result: unknown
      if (request.method === 'worktree.rm') {
        const id = (request.params.worktree ?? '').slice('id:'.length)
        accepted.set(id, (accepted.get(id) ?? 0) + 1)
        result = { removed: true, removing: true }
      } else {
        const id = request.params.worktreeId ?? ''
        const reads = (readsAfterAccept.get(id) ?? 0) + 1
        readsAfterAccept.set(id, reads)
        result = !accepted.has(id)
          ? { state: 'present' }
          : { state: reads > 1 ? 'removed' : 'removing' }
      }
      // Why the delay: replies overlap, so a simultaneous burst really meets the limit.
      setTimeout(() => {
        socket.end(
          `${JSON.stringify({ id: request.id, ok: true, result, _meta: { runtimeId: 'runtime-1' } })}\n`
        )
      }, 20)
    })
  })
  server.maxConnections = HOST_CONNECTION_LIMIT
  return new Promise((resolve) =>
    server.listen(endpoint, () =>
      resolve({
        accepted,
        close: () => {
          for (const socket of sockets) {
            socket.destroy()
          }
          server.close()
        }
      })
    )
  )
}

describe.skipIf(process.platform === 'win32')(
  'a burst of deletes past the host connection limit',
  () => {
    it('delivers every delete exactly once and waits each one out', async () => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-rm-limit-'))
      const endpoint = join(userDataPath, 'runtime.sock')
      const host = await startHost(endpoint)
      writeFileSync(
        join(userDataPath, 'orca-runtime.json'),
        JSON.stringify({
          runtimeId: 'runtime-1',
          pid: process.pid,
          transports: [{ kind: 'unix', endpoint }],
          authToken: 'token',
          startedAt: 1
        })
      )
      try {
        const client = new RuntimeClient(userDataPath, 5_000, null, null)
        const results = await Promise.all(
          Array.from({ length: REMOVALS }, (_, index) =>
            removeWorktreeAndWait(client, {
              worktree: `id:repo::/wt-${index}`,
              worktreeId: `repo::/wt-${index}`,
              hostId: 'local',
              force: true,
              allowUnverifiedPtyStop: true,
              runHooks: false,
              allowFailedArchiveHook: false
            })
          )
        )

        expect(results.map(({ result }) => result.removed)).toEqual(Array(REMOVALS).fill(true))
        expect(host.accepted.size).toBe(REMOVALS)
        expect([...host.accepted.values()].every((times) => times === 1)).toBe(true)
      } finally {
        host.close()
      }
    }, 30_000)
  }
)
