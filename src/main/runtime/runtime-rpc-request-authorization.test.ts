import { mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './device-registry'
import type { AuthenticatedMobileSocket } from './rpc/mobile-socket-wiring'
import {
  disableSecurityEventLog,
  enableSecurityEventLog,
  SECURITY_EVENT_PREFIX
} from './security-event-log'
import { sendRequest, withCurrentOrchestrationContract } from './runtime-rpc-test-harness'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('OrcaRuntimeRpcServer', () => {
  it('rejects WebSocket requests whose request token differs from the authenticated channel token', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = {
      configureNotificationDismissalStore: () => {},
      getRuntimeId: () => 'test-runtime',
      getStatus: vi.fn().mockResolvedValue({ graphStatus: 'ok' })
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const channelDevice = server['deviceRegistry']!.addDevice('phone', 'mobile')
    const requestDevice = server['deviceRegistry']!.addDevice('cli', 'runtime')
    const replies: Record<string, unknown>[] = []

    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_mismatch',
        method: 'status.get',
        deviceToken: requestDevice.token
      }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {},
      undefined,
      undefined,
      channelDevice.token
    )

    expect(replies).toContainEqual(
      expect.objectContaining({
        id: 'req_mismatch',
        ok: false,
        error: expect.objectContaining({ code: 'unauthorized' })
      })
    )
  })

  it('isolates mutation replay by the authenticated paired device across reconnects', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const firstDevice = server['deviceRegistry']!.addDevice('first-cli', 'runtime')
    const secondDevice = server['deviceRegistry']!.addDevice('second-cli', 'runtime')

    const resetMessages = async (id: string, authenticatedToken: string) => {
      const replies: Record<string, unknown>[] = []
      await server['handleWebSocketMessage'](
        JSON.stringify(
          withCurrentOrchestrationContract({
            id,
            method: 'orchestration.reset',
            orchestrationRequestId: 'paired-reset-request',
            params: { messages: true }
          })
        ),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        undefined,
        authenticatedToken
      )
      return replies[0]
    }

    try {
      db.insertMessage({
        runId: 'run_legacy_local',
        from: 'worker',
        to: 'coordinator',
        subject: 'before reset'
      })
      const first = await resetMessages('reset-first', firstDevice.token)
      db.insertMessage({
        runId: 'run_legacy_local',
        from: 'worker',
        to: 'coordinator',
        subject: 'after reset'
      })
      const replay = await resetMessages('reset-replay', firstDevice.token)

      expect(first).toMatchObject({
        ok: true,
        result: { reset: 'messages', mutation: { replayed: false } }
      })
      expect(replay).toMatchObject({
        ok: true,
        result: { reset: 'messages', mutation: { replayed: true } }
      })
      expect(db.getInbox()).toEqual([expect.objectContaining({ subject: 'after reset' })])

      const isolated = await resetMessages('reset-second-device', secondDevice.token)
      expect(isolated).toMatchObject({
        ok: true,
        result: { reset: 'messages', mutation: { replayed: false } }
      })
      expect(db.getInbox()).toEqual([])
    } finally {
      db.close()
      await server.stop()
    }
  })

  it('keeps authenticated paired callers attached to existing federated workers', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry']!.addDevice('existing-cli', 'runtime')
    const existingFingerprint = createHash('sha256').update(device.token).digest('hex')
    db.createRemoteDispatchAttachment({
      runId: 'run_home',
      dispatchId: 'ctx_existing_remote',
      taskId: 'task_existing_remote',
      homePeerFingerprint: existingFingerprint,
      protocolVersion: 1,
      runtimeEpoch: 'runtime_before_upgrade',
      mutationReceipt: {
        callerFingerprint: existingFingerprint,
        requestId: 'request_existing_remote',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'hash_existing_remote'
      }
    })
    const replies: Record<string, unknown>[] = []

    try {
      await server['handleWebSocketMessage'](
        JSON.stringify(
          withCurrentOrchestrationContract({
            id: 'show-existing-remote',
            method: 'orchestration.federationShow',
            params: { dispatchId: 'ctx_existing_remote' }
          })
        ),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {},
        undefined,
        undefined,
        device.token
      )

      expect(replies[0]).toMatchObject({
        ok: true,
        result: { dispatchId: 'ctx_existing_remote', attachment: { state: 'starting' } }
      })
    } finally {
      db.close()
      await server.stop()
    }
  })

  it('rejects unpaired terminal creates before runtime dispatch', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const createMobileSessionTerminal = vi.fn()
    const runtime = {
      configureNotificationDismissalStore: () => {},
      getRuntimeId: () => 'test-runtime',
      createMobileSessionTerminal
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const replies: Record<string, unknown>[] = []
    const send = async (id: string, deviceToken?: string): Promise<void> => {
      await server['handleWebSocketMessage'](
        JSON.stringify({
          id,
          method: 'session.tabs.createTerminal',
          ...(deviceToken ? { deviceToken } : {}),
          params: { worktree: 'id:wt-1' }
        }),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {}
      )
    }

    await send('req_missing')
    await send('req_invalid', 'invalid-token')

    expect(replies).toEqual([
      expect.objectContaining({
        id: 'req_missing',
        error: expect.objectContaining({ code: 'unauthorized' }),
        ok: false
      }),
      expect.objectContaining({
        id: 'req_invalid',
        error: expect.objectContaining({ code: 'unauthorized' }),
        ok: false
      })
    ])
    expect(createMobileSessionTerminal).not.toHaveBeenCalled()
  })

  it('records one revoked-token rejection per socket, never the token', async () => {
    const lines: string[] = []
    enableSecurityEventLog({ write: (line) => lines.push(line) })
    try {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a minimal stub; the code under test reads only the fields set here.
      const runtime = {
        configureNotificationDismissalStore: () => {},
        getRuntimeId: () => 'test-runtime'
      } as unknown as OrcaRuntimeService
      const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
      server['deviceRegistry'] = new DeviceRegistry(userDataPath)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a minimal stub; the code under test reads only the fields set here.
      const ws = {} as unknown as WebSocket
      // Why: the socket carries the transport the refusal happened on, long after its token is gone.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a minimal stub; the code under test reads only the fields set here.
      const socket = {
        ws,
        transport: { transport: 'relay' }
      } as unknown as AuthenticatedMobileSocket
      const replies: Record<string, unknown>[] = []

      for (const id of ['req_revoked_1', 'req_revoked_2']) {
        await server['handleWebSocketMessage'](
          JSON.stringify({ id, method: 'status.get' }),
          (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
          () => {},
          undefined,
          ws,
          'revoked-token',
          socket
        )
      }

      expect(replies).toEqual([
        expect.objectContaining({
          error: expect.objectContaining({ code: 'unauthorized' }),
          ok: false
        }),
        expect.objectContaining({
          error: expect.objectContaining({ code: 'unauthorized' }),
          ok: false
        })
      ])
      expect(
        lines.map((line): unknown => JSON.parse(line.slice(SECURITY_EVENT_PREFIX.length)))
      ).toEqual([
        {
          event: 'connection_rejected',
          transport: 'relay',
          code: 4001,
          reason: 'revoked or unknown token',
          ts: expect.any(Number)
        }
      ])
      expect(lines.join('\n')).not.toContain('revoked-token')
    } finally {
      disableSecurityEventLog()
    }
  })

  it('allows runtime-scoped WebSocket tokens to use the full RPC surface', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const pushRuntimeGit = vi.fn().mockResolvedValue({ ok: true })
    const runtime = {
      configureNotificationDismissalStore: () => {},
      getRuntimeId: () => 'test-runtime',
      pushRuntimeGit
    } as unknown as OrcaRuntimeService
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const runtimeDevice = server['deviceRegistry']!.addDevice('cli', 'runtime')
    const replies: Record<string, unknown>[] = []

    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req_push',
        method: 'git.push',
        deviceToken: runtimeDevice.token,
        params: { worktree: 'id:wt-1' }
      }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {}
    )

    expect(replies).toContainEqual(expect.objectContaining({ id: 'req_push', ok: true }))
    expect(pushRuntimeGit).toHaveBeenCalledWith('id:wt-1', undefined, undefined, undefined)
  })

  it('serves status.get for authenticated callers', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const response = await sendRequest(metadata!.transports[0]!.endpoint, {
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

  it('stamps the authenticated device scope onto status.get for WebSocket clients', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const mobile = server['deviceRegistry']!.addDevice('phone', 'mobile')
    const runtimeDevice = server['deviceRegistry']!.addDevice('browser', 'runtime')

    const sendStatus = async (token: string): Promise<Record<string, unknown>> => {
      const replies: Record<string, unknown>[] = []
      await server['handleWebSocketMessage'](
        JSON.stringify({ id: 'req_status', method: 'status.get', deviceToken: token }),
        (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
        () => {}
      )
      return replies[0]!
    }

    const mobileReply = await sendStatus(mobile.token)
    expect(mobileReply).toMatchObject({ id: 'req_status', ok: true })
    // Why: the mobile-scope web client reads this to refuse the full app.
    expect((mobileReply.result as { deviceScope?: string }).deviceScope).toBe('mobile')

    const runtimeReply = await sendStatus(runtimeDevice.token)
    expect((runtimeReply.result as { deviceScope?: string }).deviceScope).toBe('runtime')

    // Other methods stay unmodified — only status.get carries the scope.
    const replies: Record<string, unknown>[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'req_forbidden', method: 'files.delete', deviceToken: mobile.token }),
      (response) => replies.push(JSON.parse(response) as Record<string, unknown>),
      () => {}
    )
    expect(replies[0]).toMatchObject({
      id: 'req_forbidden',
      ok: false,
      error: { code: 'forbidden' }
    })
  })

  it('rejects requests with the wrong auth token', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })

    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)
    const response = await sendRequest(metadata!.transports[0]!.endpoint, {
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
    const response = await sendRequest(metadata!.transports[0]!.endpoint, {
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
})
