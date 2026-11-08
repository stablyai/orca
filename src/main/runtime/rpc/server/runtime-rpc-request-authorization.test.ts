import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import '../../orchestration/db/contract-constants'
import '../../orchestration/db/messages/mailbox-routing-page'
import '../../orchestration/db/dispatch-row-writer'
import '../../orchestration/db/attempt-outcome-projection'

import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { DeviceRegistry } from './pairing/device-registry'
import { sendRequest, withCurrentOrchestrationContract } from './runtime-rpc-test-harness'
import { STATUS_METHODS } from '../methods/host-management/status'
import { ORCHESTRATION_FEDERATION_CONTROL_METHODS } from '../methods/orchestration/federation/federation-control'
import { ORCHESTRATION_RESET_METHODS } from '../methods/orchestration/runs/reset-methods'
import { SESSION_TAB_METHODS } from '../methods/session-tabs/session-tabs'
import { FILE_MUTATION_METHODS } from '../methods/files/files-mutation-methods'
import { GIT_METHODS } from '../methods/source-control/git/git'

const methods = [
  ...STATUS_METHODS,
  ...ORCHESTRATION_FEDERATION_CONTROL_METHODS,
  ...ORCHESTRATION_RESET_METHODS,
  ...SESSION_TAB_METHODS,
  ...FILE_MUTATION_METHODS,
  ...GIT_METHODS
]

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listings.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  function createWorktreeListingMocks() {
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
  }
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

describe('OrcaRuntimeRpcServer', () => {
  it('isolates mutation replay by the authenticated paired device across reconnects', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      methods,
      userDataPath,
      enableWebSocket: false
    })
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
    const server = new OrcaRuntimeRpcServer({
      runtime,
      methods,
      userDataPath,
      enableWebSocket: false
    })
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

  it('rejects requests with the wrong auth token', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, methods, userDataPath })

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
})
