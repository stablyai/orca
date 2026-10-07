import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as secureFile from '../../shared/secure-file'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { readRuntimeMetadata } from './runtime-metadata'
import { sendRequest } from './runtime-rpc-test-harness'

describe('runtime access when the registry cannot be loaded', () => {
  it.each(['permission', 'corrupt'] as const)(
    'reports unknown grants after a %s failure',
    async (failure) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-access-load-'))
      const registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)
      const contents = failure === 'corrupt' ? '{broken' : '[]'
      writeFileSync(registryPath, contents)
      const original = secureFile.hardenExistingSecureFile
      const harden = vi
        .spyOn(secureFile, 'hardenExistingSecureFile')
        .mockImplementation((path, ...args) => {
          if (failure === 'permission' && path === registryPath) {
            throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' })
          }
          return original(path, ...args)
        })
      const server = new OrcaRuntimeRpcServer({
        runtime: new OrcaRuntimeService(),
        userDataPath,
        enableWebSocket: true,
        wsPort: 0
      })
      try {
        await server.start()
        const metadata = readRuntimeMetadata(userDataPath)!
        const endpoint = metadata.transports.find((transport) => transport.kind !== 'websocket')!
        for (const method of ['runtimeAccess.list', 'runtimeAccess.revoke']) {
          expect(
            await sendRequest(endpoint.endpoint, {
              id: method,
              authToken: metadata.authToken,
              method,
              params: { deviceId: '00000000-0000-4000-8000-000000000000' }
            })
          ).toMatchObject({
            ok: false,
            error: {
              code: 'runtime_access_unavailable',
              message: expect.stringContaining('grants unknown')
            }
          })
        }
        expect(readFileSync(registryPath, 'utf8')).toBe(contents)
      } finally {
        harden.mockRestore()
        await server.stop()
        rmSync(userDataPath, { recursive: true, force: true })
      }
    }
  )
})
