import '../unused-default-rpc-methods.test-fixture'
import { existsSync, mkdtempSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import {
  IROH_ENDPOINT_SECRET_FILENAME,
  loadOrCreateIrohEndpointSecret
} from '../iroh-endpoint-secret'
import { createFakeBind, FakeRecv, FakeSend } from '../iroh-transport.test-fixture'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    readSync: vi.fn(actual.readSync),
    writeFileSync: vi.fn(actual.writeFileSync)
  }
})

const actual = await vi.importActual<typeof NodeFs>('node:fs')

describe('runtime Iroh identity diagnostics', () => {
  it.each(['read', 'write'] as const)(
    'identifies a real %s failure without exposing keys, then recovers within existing backoff',
    async (operation) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-iroh-identity-'))
      const file = join(userDataPath, IROH_ENDPOINT_SECRET_FILENAME)
      const original = operation === 'read' ? loadOrCreateIrohEndpointSecret(userDataPath) : null
      const privateData = original
        ? Buffer.from(original).toString('base64')
        : 'private-key-excerpt'
      let blocked = true
      if (operation === 'read') {
        vi.mocked(readSync).mockImplementation(() => {
          throw Object.assign(new Error(`stale private key ${privateData}`), { code: 'ESTALE' })
        })
      } else {
        vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
          if (blocked && typeof path === 'string' && path.startsWith(`${file}.`)) {
            throw Object.assign(new Error(`cannot persist ${privateData}`), { code: 'ENOSPC' })
          }
          actual.writeFileSync(path, data, options)
        })
      }
      const fake = createFakeBind(new FakeRecv(), new FakeSend())
      const server = new OrcaRuntimeRpcServer({
        runtime: new OrcaRuntimeService(),
        methods: [],
        userDataPath,
        enableWebSocket: true,
        wsPort: 0,
        irohBindEndpoint: fake.bindEndpoint
      })
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        await server.start()
        await server.setIrohRelayUrl(null)
        expect(server.getIrohStatus().bound).toBe(false)
        expect(fake.bindEndpoint).not.toHaveBeenCalled()
        expect(errors).toHaveBeenCalledOnce()
        expect(errors).toHaveBeenLastCalledWith(
          expect.stringContaining(`Cannot ${operation} the Iroh endpoint secret`)
        )
        expect(JSON.stringify(errors.mock.calls)).not.toContain(privateData)
        expect(JSON.stringify(errors.mock.calls)).not.toContain('Failed to bind')
        expect(existsSync(file)).toBe(operation === 'read')

        await vi.advanceTimersByTimeAsync(999)
        expect(errors).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(1)
        expect(errors).toHaveBeenCalledTimes(2)
        expect(fake.bindEndpoint).not.toHaveBeenCalled()
        expect(JSON.stringify(errors.mock.calls)).not.toContain(privateData)

        blocked = false
        vi.mocked(readSync).mockImplementation(actual.readSync)
        await vi.advanceTimersByTimeAsync(2_000)
        expect(server.getIrohStatus().bound).toBe(true)
        expect(fake.bindEndpoint).toHaveBeenCalledOnce()
        const boundSecret = fake.bindEndpoint.mock.calls[0]![0]
        expect(loadOrCreateIrohEndpointSecret(userDataPath)).toEqual(boundSecret)
        if (original) {
          expect(boundSecret).toEqual(original)
          expect(readFileSync(file, 'utf8')).toContain(privateData)
        }
      } finally {
        vi.mocked(readSync).mockImplementation(actual.readSync)
        vi.mocked(writeFileSync).mockImplementation(actual.writeFileSync)
        vi.useRealTimers()
        await server.stop()
        errors.mockRestore()
        rmSync(userDataPath, { recursive: true, force: true })
      }
    }
  )
})
