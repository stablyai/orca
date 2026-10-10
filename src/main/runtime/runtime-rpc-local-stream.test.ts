import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../shared/terminal-stream-protocol'
import { sendRequest } from './runtime-rpc-test-harness'
import { openLocalStreamTestClient } from './runtime-rpc-local-stream-test-harness'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import type { WorkspaceCreatorProvenance } from '../../shared/worktree/types'

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

const TerminalCreateResult = z.object({ terminal: z.object({ handle: z.string() }) })

function readTerminalHandle(result: unknown): string {
  return TerminalCreateResult.parse(result).terminal.handle
}

async function startServer(writes: { terminal: string; text: string }[] = []) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-local-stream-'))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared RPC fixture implements only the store methods these RPC paths read, as in the WebSocket streaming tests.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: 'local-stream-pty' }),
    write: (ptyId, data) => {
      writes.push({ terminal: ptyId, text: data })
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
  await server.start()
  const metadata = readRuntimeMetadata(userDataPath)
  const endpoint = metadata?.transports[0]?.endpoint
  const authToken = metadata?.authToken
  if (!endpoint || !authToken) {
    throw new Error('runtime metadata was not published')
  }
  return { runtime, server, endpoint, authToken }
}

describe('OrcaRuntimeRpcServer local stream transport', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_LOCAL_STREAM_TRANSPORT', '1')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('upgrades an owner connection and serves requests on it while unary calls keep working', async () => {
    const { server, endpoint, authToken } = await startServer()
    const client = await openLocalStreamTestClient(endpoint, authToken)
    try {
      expect(client.upgradeResponse).toMatchObject({
        id: 'upgrade',
        ok: true,
        result: { protocol: 'orca-local-stream', version: 1 }
      })
      expect(server.readClientActivity().openConnections).toBe(1)

      client.sendRequest({ id: 'status', method: 'status.get' })
      await vi.waitFor(() =>
        expect(client.responses).toContainEqual(expect.objectContaining({ id: 'status', ok: true }))
      )
      client.sendRequest({ id: 'wrong', authToken: 'not-the-owner', method: 'status.get' })
      await vi.waitFor(() =>
        expect(client.responses).toContainEqual(
          expect.objectContaining({
            id: 'wrong',
            ok: false,
            error: expect.objectContaining({ code: 'unauthorized' })
          })
        )
      )

      await expect(
        sendRequest(endpoint, { id: 'unary', authToken, method: 'status.get' })
      ).resolves.toMatchObject({ id: 'unary', ok: true })
    } finally {
      client.close()
      await client.closed
      await vi.waitFor(() => expect(server.readClientActivity().openConnections).toBe(0))
      await server.stop()
    }
  })

  it('refuses an upgrade with a bad token or an unsupported version and closes the socket', async () => {
    const { server, endpoint, authToken } = await startServer()
    try {
      const badToken = await openLocalStreamTestClient(endpoint, 'nope')
      expect(badToken.upgradeResponse).toMatchObject({
        ok: false,
        error: { code: 'unauthorized' }
      })
      await badToken.closed

      const badVersion = await openLocalStreamTestClient(endpoint, authToken, {
        protocol: 'orca-local-stream',
        versions: [99]
      })
      expect(badVersion.upgradeResponse).toMatchObject({
        ok: false,
        error: { code: 'unsupported_transport', data: { versions: [1] } }
      })
      await badVersion.closed
      expect(server.readClientActivity().openConnections).toBe(0)
    } finally {
      await server.stop()
    }
  })

  it('creates workspaces as the host, as a unary call from the CLI does', async () => {
    const { runtime, server, endpoint, authToken } = await startServer()
    const provenances: (WorkspaceCreatorProvenance | undefined)[] = []
    vi.spyOn(runtime, 'createFolderWorkspace').mockImplementation(async (args) => {
      provenances.push(args.creatorProvenance)
      throw new Error('folder_workspace_test_stop')
    })
    const params = { projectGroupId: 'group-1', name: 'scratch' }
    const client = await openLocalStreamTestClient(endpoint, authToken)
    try {
      client.sendRequest({ id: 'create', method: 'folderWorkspace.create', params })
      await vi.waitFor(() =>
        expect(client.responses).toContainEqual(expect.objectContaining({ id: 'create' }))
      )
      await sendRequest(endpoint, {
        id: 'unary',
        authToken,
        method: 'folderWorkspace.create',
        params
      })
      expect(provenances).toEqual([{ kind: 'host' }, { kind: 'host' }])
    } finally {
      client.close()
      await client.closed
      await server.stop()
    }
  })

  it('answers the upgrade like an older runtime when the kill switch is set', async () => {
    vi.stubEnv('ORCA_LOCAL_STREAM_TRANSPORT', '0')
    const { server, endpoint, authToken } = await startServer()
    try {
      const client = await openLocalStreamTestClient(endpoint, authToken)
      expect(client.upgradeResponse).toMatchObject({
        id: 'upgrade',
        ok: false,
        error: { code: 'method_not_found' }
      })
      client.close()
      await client.closed
      await expect(
        sendRequest(endpoint, { id: 'unary', authToken, method: 'status.get' })
      ).resolves.toMatchObject({ id: 'unary', ok: true })
    } finally {
      vi.unstubAllEnvs()
      await server.stop()
    }
  })

  it('carries terminal.multiplex binary frames both ways and cleans up on disconnect', async () => {
    const writes: { terminal: string; text: string }[] = []
    const { runtime, server, endpoint, authToken } = await startServer(writes)
    const created = await sendRequest(endpoint, {
      id: 'create',
      authToken,
      method: 'terminal.create',
      params: {
        worktree: 'id:repo-1::/tmp/worktree-a',
        command: 'shell',
        tabId: 'local-stream-tab',
        leafId: '11111111-1111-4111-8111-111111111111'
      }
    })
    const handle = readTerminalHandle(created.result)
    const client = await openLocalStreamTestClient(endpoint, authToken, {
      protocol: 'orca-local-stream',
      versions: [1],
      clientCapabilities: ['terminal.binary-stream.v1', 'terminal.multiplex.v1']
    })
    try {
      client.sendRequest({ id: 'mux', method: 'terminal.multiplex', params: {} })
      await vi.waitFor(() =>
        expect(client.responses).toContainEqual(
          expect.objectContaining({ id: 'mux', result: { type: 'ready' } })
        )
      )
      client.sendBinary(
        encodeTerminalStreamFrame({
          seq: 1,
          opcode: TerminalStreamOpcode.Subscribe,
          streamId: 0,
          payload: encodeTerminalStreamJson({
            streamId: 7,
            terminal: handle,
            client: { id: 'native-client', type: 'desktop' },
            capabilities: { ackOutput: 1 }
          })
        })
      )
      await vi.waitFor(() =>
        expect(client.responses).toContainEqual(
          expect.objectContaining({
            id: 'mux',
            result: expect.objectContaining({ type: 'subscribed', streamId: 7 })
          })
        )
      )

      runtime.onPtyData('local-stream-pty', 'LOCAL_STREAM_OUTPUT\r\n', 1)
      await vi.waitFor(() => {
        const output = client.binaryFrames
          .map((frame) => decodeTerminalStreamFrame(frame))
          .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output && frame.streamId === 7)
          .map((frame) => (frame ? decodeTerminalStreamText(frame.payload) : ''))
          .join('')
        expect(output).toContain('LOCAL_STREAM_OUTPUT')
      })

      client.sendBinary(
        encodeTerminalStreamFrame({
          seq: 2,
          opcode: TerminalStreamOpcode.Input,
          streamId: 7,
          payload: encodeTerminalStreamText('typed\r')
        })
      )
      await vi.waitFor(() =>
        expect(writes).toContainEqual({ terminal: 'local-stream-pty', text: 'typed\r' })
      )
    } finally {
      client.close()
      await client.closed
      await vi.waitFor(() => expect(server.readClientActivity().openConnections).toBe(0))
      await server.stop()
    }
  })
})
