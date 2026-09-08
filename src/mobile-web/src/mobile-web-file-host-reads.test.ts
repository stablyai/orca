import { describe, expect, it } from 'vitest'
import type {
  MobileWebBridgePageMessage,
  MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'
import { sanitizeDirectoryResult } from '../../shared/mobile-web/file-host-presentation'

const context = { shellSessionId: 'S'.repeat(43), buildId: 'a'.repeat(64) }
const directory = { workspaceId: 'workspace_opaque', relativePath: '', limit: 10 }
const chunk = {
  workspaceId: directory.workspaceId,
  relativePath: 'report.bin',
  offset: 4,
  length: 3
}
const entries = [
  { name: 'z.txt', isDirectory: false },
  { name: 'src', isDirectory: true }
]

function fixture(generic = true) {
  const messages: MobileWebBridgePageMessage[] = []
  const limits = {
    maxRequestBytes: 16384,
    maxResponseBytes: 524288,
    maxConcurrent: 4,
    rateCapacity: 16,
    rateRefillPerSecond: 4
  }
  const client = new MobileWebBridgeClient({
    context,
    grants: [
      { capability: 'file', operation: 'directory', limits },
      { capability: 'file', operation: 'list', limits },
      { capability: 'file', operation: 'search', limits },
      { capability: 'file', operation: 'read', limits },
      { capability: 'file', operation: 'readChunk', limits },
      ...(generic ? [{ capability: 'workspace' as const, operation: 'hostRequest', limits }] : [])
    ],
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => 'R'.repeat(22)
  })
  const respond = (
    result: unknown,
    code?: 'too_large' | 'unsupported_capability' | 'host_error'
  ) => {
    client.receive({
      version: 2,
      type: 'response',
      ...context,
      requestId: 'R'.repeat(22),
      ...(code
        ? { status: 'error', error: { code, retryable: false } }
        : { status: 'success', payload: result })
    } as MobileWebBridgeShellMessage)
  }
  return { client, messages, respond }
}

describe('page-owned generic file reads', () => {
  it('uses the bounded Desktop directory result with an opaque workspace', async () => {
    const { client, messages, respond } = fixture()
    const result = client.fileDirectory(directory)
    expect(messages[0]).toMatchObject({
      capability: 'workspace',
      operation: 'hostRequest',
      payload: {
        method: 'mobileWeb.files.readDir',
        workspaceId: directory.workspaceId,
        params: { relativePath: '', limit: 10 }
      }
    })
    respond({ ...sanitizeDirectoryResult(entries, '', 10), futureField: 'desktop-added' })
    await expect(result).resolves.toEqual({
      ...sanitizeDirectoryResult(entries, '', 10),
      workspaceId: directory.workspaceId
    })
    client.dispose()
  })

  it('rejects a directory response for a different path', async () => {
    const { client, respond } = fixture()
    const result = client.fileDirectory(directory)
    respond(sanitizeDirectoryResult(entries, 'different', 10))
    await expect(result).rejects.toMatchObject({ code: 'invalid_message' })
    client.dispose()
  })

  it('decodes binary chunks without a shell file projection', async () => {
    const { client, messages, respond } = fixture()
    const result = client.fileReadChunk(chunk)
    expect(messages[0]).toMatchObject({
      operation: 'hostRequest',
      payload: {
        method: 'files.readChunk',
        params: { relativePath: 'report.bin', offset: 4, length: 3 }
      }
    })
    respond({ contentBase64: 'AAH/', bytesRead: 3, eof: true, futureField: 1 })
    await expect(result).resolves.toMatchObject({
      workspaceId: directory.workspaceId,
      offset: 4,
      bytes: new Uint8Array([0, 1, 255])
    })
    client.dispose()
  })

  it.each(['too_large', 'unsupported_capability'] as const)(
    'does not retry when the host returns %s',
    async (code) => {
      const { client, messages, respond } = fixture()
      const result = client.fileDirectory(directory)
      respond(null, code)
      await expect(result).rejects.toMatchObject({ code })
      expect(messages).toHaveLength(1)
      client.dispose()
    }
  )

  it('rejects missing baseline grant without sending a legacy request', async () => {
    const { client, messages } = fixture(false)
    await expect(client.fileDirectory(directory)).rejects.toMatchObject({
      code: 'unsupported_capability'
    })
    expect(messages).toHaveLength(0)
    client.dispose()
  })

  it('does not hide host errors by issuing a second read', async () => {
    const { client, messages, respond } = fixture()
    const result = client.fileDirectory(directory)
    respond(null, 'host_error')
    await expect(result).rejects.toMatchObject({ code: 'host_error' })
    expect(messages).toHaveLength(1)
    client.dispose()
  })

  it('refuses a chunk larger than requested', async () => {
    const { client, respond } = fixture()
    const result = client.fileReadChunk(chunk)
    respond({ contentBase64: 'AAH/AA==', bytesRead: 4, eof: true })
    await expect(result).rejects.toMatchObject({ code: 'invalid_message' })
    client.dispose()
  })
})

describe('page-safe file listing and text', () => {
  it('searches through the host privacy adapter using an opaque workspace', async () => {
    const { client, messages, respond } = fixture()
    const result = client.fileSearch({
      workspaceId: directory.workspaceId,
      query: 'report',
      limit: 10
    })
    expect(messages[0]).toMatchObject({
      operation: 'hostRequest',
      payload: {
        method: 'mobileWeb.files.searchPaths',
        workspaceId: directory.workspaceId,
        params: { query: 'report', limit: 10 }
      }
    })
    respond({
      files: [{ relativePath: 'docs/report.md', basename: 'report.md', kind: 'text' }],
      totalCount: 1,
      truncated: false,
      futureField: true
    })
    await expect(result).resolves.toEqual({
      workspaceId: directory.workspaceId,
      files: [{ relativePath: 'docs/report.md', basename: 'report.md', kind: 'text' }],
      totalCount: 1,
      truncated: false
    })
    client.dispose()
  })

  it('reads Unicode content directly without a shell base64 projection', async () => {
    const { client, messages, respond } = fixture()
    const result = client.fileRead({
      workspaceId: directory.workspaceId,
      relativePath: 'report.txt'
    })
    expect(messages[0]).toMatchObject({
      operation: 'hostRequest',
      payload: { method: 'mobileWeb.files.read' }
    })
    const content = '\uFEFFhello 🌍'
    const byteLength = new TextEncoder().encode(content).byteLength
    respond({
      relativePath: 'report.txt',
      content,
      truncated: false,
      byteLength,
      futureField: 'new'
    })
    await expect(result).resolves.toEqual({
      workspaceId: directory.workspaceId,
      relativePath: 'report.txt',
      content,
      truncated: false,
      byteLength
    })
    client.dispose()
  })

  it('rejects inconsistent content size', async () => {
    const { client, respond } = fixture()
    const result = client.fileRead({
      workspaceId: directory.workspaceId,
      relativePath: 'report.txt'
    })
    respond({ relativePath: 'report.txt', content: '🌍', truncated: false, byteLength: 1 })
    await expect(result).rejects.toMatchObject({ code: 'invalid_message' })
    client.dispose()
  })
})
