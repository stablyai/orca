import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { sshBridgeCredentials } from './rpc/ssh-bridge-credentials'
import type { RpcResponse } from './rpc/core'

const BRIDGE_SCOPE = { kind: 'ssh-bridge', targetId: 'box-1', remoteCliControl: false } as const

function createServer(): OrcaRuntimeRpcServer {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-bridge-'))
  return new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: false
  })
}

async function send(
  server: OrcaRuntimeRpcServer,
  authToken: string,
  method: string,
  params: unknown = {}
): Promise<RpcResponse> {
  return server['handleMessage'](JSON.stringify({ id: `req-${method}`, authToken, method, params }))
}

function errorCode(response: RpcResponse): string | null {
  return response.ok ? null : response.error.code
}

describe('the runtime socket and SSH bridge credentials', () => {
  it('scopes a bridge credential to its SSH target instead of owner authority', async () => {
    const server = createServer()
    const credential = sshBridgeCredentials.mint(BRIDGE_SCOPE)
    try {
      expect(errorCode(await send(server, credential.token, 'computer.click'))).toBe('forbidden')
      expect(errorCode(await send(server, credential.token, 'accounts.selectClaude'))).toBe(
        'forbidden'
      )
      expect(errorCode(await send(server, credential.token, 'skills.install'))).toBe('forbidden')
      expect((await send(server, credential.token, 'status.get')).ok).toBe(true)
    } finally {
      credential.revoke()
    }
  })

  it('rejects a credential once its invocation settled', async () => {
    const server = createServer()
    const credential = sshBridgeCredentials.mint(BRIDGE_SCOPE)
    credential.revoke()
    expect(errorCode(await send(server, credential.token, 'status.get'))).toBe('unauthorized')
  })

  it('keeps the owner token unscoped', async () => {
    const server = createServer()
    const response = await send(server, server['authToken'], 'computer.click')
    expect(errorCode(response)).not.toBe('forbidden')
  })
})
