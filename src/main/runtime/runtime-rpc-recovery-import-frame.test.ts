import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { sendRequest } from './runtime-rpc-test-harness'

const { importRecoveryWorkspace } = vi.hoisted(() => ({ importRecoveryWorkspace: vi.fn() }))
vi.mock('./cross-machine-recovery/recovery-import', () => ({ importRecoveryWorkspace }))

const MIB = 1024 * 1024

function writeRawFrame(endpoint: string, frame: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      socket.end()
      resolve(JSON.parse(buffer.slice(0, newlineIndex)))
    })
    socket.on('connect', () => {
      socket.write(`${frame}\n`)
    })
  })
}

describe('crossMachineRecovery.import frame budget over the unix socket', () => {
  let server: OrcaRuntimeRpcServer
  let endpoint: string
  let authToken: string

  beforeEach(async () => {
    importRecoveryWorkspace.mockReset()
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-recovery-frame-'))
    server = new OrcaRuntimeRpcServer({ runtime: new OrcaRuntimeService(), userDataPath })
    await server.start()
    const metadata = readRuntimeMetadata(userDataPath)
    endpoint = metadata!.transports[0]!.endpoint
    authToken = metadata!.authToken
  })

  afterEach(async () => {
    await server.stop()
  })

  it('delivers a 3.9 MiB descriptor to the import handler', async () => {
    importRecoveryWorkspace.mockResolvedValue({ disposition: 'imported' })
    const padding = 'x'.repeat(Math.floor(3.9 * MIB))

    const response = await sendRequest(endpoint, {
      id: 'req_import',
      authToken,
      method: 'crossMachineRecovery.import',
      params: { descriptor: { padding }, checkoutPath: '/tmp/checkout', checkpointId: 'cp-1' }
    })

    expect(response).toMatchObject({ ok: true, result: { disposition: 'imported' } })
    expect(importRecoveryWorkspace).toHaveBeenCalledTimes(1)
    expect(importRecoveryWorkspace.mock.calls[0]![1].descriptor.padding).toHaveLength(
      padding.length
    )
  })

  it('still rejects a 1.1 MiB frame for any other method', async () => {
    const response = await sendRequest(endpoint, {
      id: 'req_list',
      authToken,
      method: 'crossMachineRecovery.list',
      params: { worktree: `path:${'x'.repeat(Math.floor(1.1 * MIB))}` }
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'request_too_large' } })
  })

  it('rejects a duplicate method key that tries to borrow the import allowance', async () => {
    const params = JSON.stringify({ padding: 'x'.repeat(Math.floor(1.1 * MIB)) })
    const frame = `{"id":"req_smuggle","authToken":"${authToken}","method":"crossMachineRecovery.import","params":${params},"method":"crossMachineRecovery.list"}`

    const response = await writeRawFrame(endpoint, frame)

    expect(response).toMatchObject({ ok: false, error: { code: 'request_too_large' } })
    expect(importRecoveryWorkspace).not.toHaveBeenCalled()
  })

  it('rejects an import frame beyond the descriptor cap plus envelope headroom', async () => {
    const response = await sendRequest(endpoint, {
      id: 'req_import_huge',
      authToken,
      method: 'crossMachineRecovery.import',
      params: { descriptor: { padding: 'x'.repeat(5 * MIB + 1) } }
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'request_too_large' } })
    expect(importRecoveryWorkspace).not.toHaveBeenCalled()
  })
})
