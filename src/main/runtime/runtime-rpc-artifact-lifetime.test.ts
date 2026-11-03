import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type WebSocket from 'ws'
import { expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import {
  createArtifactSession,
  readArtifactSession,
  releaseArtifactSession
} from '../github/client/actions/artifact-download-sessions'

class TestSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
}

it('releases a completed acquisition on socket disconnect while preserving another socket’s transfer', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-artifact-rpc-'))
  const runtime = new OrcaRuntimeService()
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  const registry = new DeviceRegistry(userDataPath)
  server['deviceRegistry'] = registry
  const device = registry.addDevice('artifact-test', 'runtime')
  const start = vi
    .spyOn(runtime, 'startRepoActionsArtifactDownload')
    .mockImplementation(async (repo, _query, signal, onRelease) =>
      createArtifactSession(repo, Buffer.from('fixture ZIP'), 'fixture.zip', signal, onRelease)
    )
  const firstSocket = new TestSocket()
  const secondSocket = new TestSocket()
  const transfers: { transferId: string; owner: string }[] = []
  async function download(socket: TestSocket, owner: string) {
    const replies: unknown[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispatch only reads this fake socket's OPEN/readyState and event methods.
    const ws = socket as unknown as WebSocket
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: owner,
        deviceToken: device.token,
        method: 'github.startActionsArtifactDownload',
        params: {
          repo: owner,
          repository: { owner: 'acme', repo: 'widgets', host: 'github.com' },
          runId: 1,
          artifactId: 1
        }
      }),
      (reply) => replies.push(JSON.parse(reply)),
      () => {},
      undefined,
      ws
    )
    expect(replies).toEqual([expect.objectContaining({ ok: true })])
    const result = await start.mock.results.at(-1)?.value
    transfers.push({ transferId: result.transferId, owner })
    return result
  }
  try {
    const first = await download(firstSocket, 'first')
    const second = await download(secondSocket, 'second')
    expect(firstSocket.listenerCount('close')).toBe(1)
    expect(secondSocket.listenerCount('close')).toBe(1)
    firstSocket.readyState = 3
    firstSocket.emit('close')
    expect(() => readArtifactSession(first.transferId, 'first', 0)).toThrow('expired')
    expect(readArtifactSession(second.transferId, 'second', 0).done).toBe(true)
    releaseArtifactSession(second.transferId, 'second')
    expect(secondSocket.listenerCount('close')).toBe(0)
  } finally {
    for (const transfer of transfers) {
      releaseArtifactSession(transfer.transferId, transfer.owner)
    }
    start.mockRestore()
    await server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
