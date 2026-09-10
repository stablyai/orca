import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import type { OrcaRuntimeService } from './orca-runtime'
import { readRuntimeMetadata } from './runtime-metadata'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import {
  authenticateMobileWsSession,
  createEncryptedWsResponseReader,
  sendEncryptedWsRequest
} from './runtime-rpc-mobile-ws-test-harness'
import { LINEAR_METHODS } from './rpc/methods/linear'
import { listMcpIssues } from '../linear/mcp-issue-list'
import type { LinearMcpIssueListRequest } from '../../shared/linear/mcp-issue-list'

const fixture = vi.hoisted(() => ({
  workspace: {
    id: 'fixture',
    organizationId: 'fixture',
    organizationName: 'Fixture',
    displayName: 'Fixture',
    email: null,
    credentialRevision: 1
  }
}))
vi.mock('../linear/client', () => ({
  getStatus: () => ({ workspaces: [fixture.workspace], activeWorkspaceId: 'fixture' }),
  getClients: () => [
    {
      workspace: fixture.workspace,
      client: { options: { apiKey: 'synthetic-fixture' } },
      apiKey: 'synthetic-fixture'
    }
  ]
}))
vi.mock('../linear/linear-token-store', () => ({ clearToken: vi.fn() }))

const folders: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  folders.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true }))
})

function row(size: number) {
  return {
    id: 'issue',
    identifier: 'F-1',
    title: 'Fixture',
    url: 'https://linear.app/fixture',
    description: 'x'.repeat(size)
  }
}

describe('Linear page delivery through actual runtime local socket lifecycle', () => {
  it.each(['local', 'paired'] as const)(
    'delivers bounded complete/pressure/error replies and next usable request through %s',
    async (route) => {
      let size = 130 * 1024
      let oversizedMeta = false
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({
            data: {
              issues: {
                nodes: [row(size)],
                pageInfo: { hasNextPage: false }
              }
            }
          })
        )
      )
      const runtime = {
        getRuntimeId: () => (oversizedMeta ? 'm'.repeat(20 * 1024) : 'fixture-runtime'),
        getStartedAt: () => '2026-09-08T00:00:00Z',
        cleanupSubscriptionsForConnection: vi.fn(),
        cancelMobileDictationForConnection: vi.fn(),
        onClientDisconnected: vi.fn(),
        linearMcpIssueList: (
          request: LinearMcpIssueListRequest,
          options: Parameters<typeof listMcpIssues>[1]
        ) => listMcpIssues(request, options)
      } as unknown as OrcaRuntimeService
      const folder = mkdtempSync(join(tmpdir(), 'orca-linear-page-'))
      folders.push(folder)
      const server = new OrcaRuntimeRpcServer({
        runtime,
        userDataPath: folder,
        methods: LINEAR_METHODS,
        enableWebSocket: route === 'paired',
        wsPort: 0
      })
      await server.start()
      try {
        const metadata = readRuntimeMetadata(folder)!
        const offer =
          route === 'paired'
            ? server.createPairingOffer({
                address: '127.0.0.1',
                name: 'synthetic-fixture',
                scope: 'runtime'
              })
            : null
        if (offer && !offer.available) {
          throw new Error('Synthetic pairing unavailable')
        }
        const session = offer?.available
          ? await authenticateMobileWsSession(offer.pairingUrl)
          : null
        const reader = session ? createEncryptedWsResponseReader(session) : null
        const local = session ? null : createConnection(metadata.transports[0].endpoint)
        if (local) {
          await once(local, 'connect')
        }
        const lines = local ? createInterface({ input: local }) : null
        const encryptedSizes: number[] = []
        session?.ws.on('message', (message) =>
          encryptedSizes.push(
            Array.isArray(message)
              ? message.reduce((total, part) => total + part.byteLength, 0)
              : message.byteLength
          )
        )
        const call = async (cursor?: string) => {
          const request = {
            id: 'fixture-call',
            method: 'linear.mcpListIssues',
            params: { workspaceId: 'fixture', limit: 1, ...(cursor ? { cursor } : {}) }
          }
          if (session) {
            sendEncryptedWsRequest(session, request)
          }
          const localReply = lines ? once(lines, 'line') : null
          local?.write(`${JSON.stringify({ ...request, authToken: metadata.authToken })}\n`)
          const response =
            session && reader
              ? await reader.next(request.id)
              : JSON.parse((await localReply!)[0] as string)
          expect(Buffer.byteLength(JSON.stringify(response, null, 2)) + 1).toBeLessThanOrEqual(
            1024 * 1024
          )
          return response as {
            ok: boolean
            result?: { issues: { description: string }[] }
            error?: { code: string; data: { retryPosition: { cursor?: string } } }
          }
        }
        expect((await call()).result?.issues[0].description).toHaveLength(130 * 1024)
        size = 950 * 1024
        expect((await call()).error?.code).toBe('linear_list_record_too_large')
        size = 1
        expect((await call()).ok).toBe(true)
        oversizedMeta = true
        const fallback = await call('input-position')
        expect(fallback.error?.code).toBe('linear_list_metadata_capacity')
        expect(fallback.error?.data.retryPosition.cursor).toBe('input-position')
        expect(fallback.result).toBeUndefined()
        oversizedMeta = false
        expect((await call('input-position')).ok).toBe(true)
        expect(encryptedSizes.every((size) => size <= 2_839_948)).toBe(true)
        lines?.close()
        local?.destroy()
        reader?.dispose()
        session?.ws.close()
      } finally {
        await server.stop()
      }
    }
  )
})
