import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import { ORCA_SSH_BRIDGE_CREDENTIAL_ENV } from '../../shared/ssh-bridge-credential-env'
import { sendRequest } from './transport'

afterEach(() => {
  vi.unstubAllEnvs()
})

async function captureAuthToken(): Promise<string> {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-bridge-transport-'))
  const endpoint = join(userDataPath, 'runtime.sock')
  let authToken = ''
  const server = createServer((socket) => {
    socket.once('data', (data) => {
      const request: { id: string; authToken: string } = JSON.parse(String(data).trim())
      authToken = request.authToken
      socket.end(
        `${JSON.stringify({ id: request.id, ok: true, result: {}, _meta: { runtimeId: 'runtime-1' } })}\n`
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  const metadata: RuntimeMetadata = {
    runtimeId: 'runtime-1',
    pid: 123,
    transports: [{ kind: 'unix', endpoint }],
    authToken: 'owner-token',
    startedAt: 1
  }
  try {
    await sendRequest(metadata, 'status.get', undefined, 5_000)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  return authToken
}

describe.skipIf(process.platform === 'win32')('runtime transport credentials', () => {
  it('presents the SSH bridge credential instead of the owner token when bridged', async () => {
    vi.stubEnv(ORCA_SSH_BRIDGE_CREDENTIAL_ENV, 'sshb_scoped')
    expect(await captureAuthToken()).toBe('sshb_scoped')
  })

  it('presents the owner token outside the bridge', async () => {
    vi.stubEnv(ORCA_SSH_BRIDGE_CREDENTIAL_ENV, '')
    expect(await captureAuthToken()).toBe('owner-token')
  })
})
