import { describe, expect, it } from 'vitest'
import {
  MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
  type MobileWebBridgePageMessage,
  type MobileWebBridgeShellMessage
} from '../../shared/mobile-web/bridge-contract'
import { MobileWebBridgeClient } from './mobile-web-bridge-client'
import { mobileWebFileRevision } from './mobile-web-file-edit-content'

const CONTEXT = {
  shellSessionId: 'S'.repeat(43),
  buildId: 'a'.repeat(64)
}
const REQUEST_ID = 'R'.repeat(22)
const WORKSPACE_ID = 'repo-1::/workspace'
const RELATIVE_PATH = 'src/index.ts'
const CONTENT = new TextEncoder().encode('after')
const CONTENT_BASE64 = btoa(String.fromCharCode(...CONTENT))
const REVISION = mobileWebFileRevision(CONTENT)

describe('mobile web file request client', () => {
  it('writes through the generic host lane and accepts its exact result identity', async () => {
    const harness = createHarness()
    const write = harness.client.fileWrite(writePayload())

    expect(harness.messages[0]).toMatchObject({
      capability: 'workspace',
      operation: 'hostRequest',
      payload: {
        method: 'mobileWeb.files.write',
        workspaceId: WORKSPACE_ID,
        params: {
          relativePath: RELATIVE_PATH,
          expectedRevision: 'a'.repeat(64),
          contentBase64: CONTENT_BASE64
        }
      }
    })
    harness.client.receive(response(hostWriteResult()))

    await expect(write).resolves.toEqual(writeResult())
  })

  it('rejects cross-path, wrong-revision, and wrong-length write results', async () => {
    for (const result of [
      hostWriteResult({ relativePath: 'src/other.ts' }),
      hostWriteResult({ revision: 'b'.repeat(64) }),
      hostWriteResult({ byteLength: CONTENT.byteLength + 1 })
    ]) {
      const harness = createHarness()
      const write = harness.client.fileWrite(writePayload())
      harness.client.receive(response(result))

      await expect(write).rejects.toMatchObject({
        code: 'invalid_message',
        retryable: false
      })
    }
  })

  it('surfaces a refused write as the outcome the desktop named', async () => {
    for (const outcome of ['conflict', 'too_large'] as const) {
      const harness = createHarness()
      const write = harness.client.fileWrite(writePayload())
      harness.client.receive(response({ outcome }))

      await expect(write).rejects.toMatchObject({ code: outcome, retryable: false })
    }
  })

  it('opens a file through the generic host lane and requires the host acknowledgement', async () => {
    const harness = createHarness()
    const open = harness.client.fileOpen({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH
    })
    expect(harness.messages[0]).toMatchObject({
      capability: 'workspace',
      operation: 'hostRequest',
      payload: {
        method: 'mobileWeb.files.open',
        workspaceId: WORKSPACE_ID,
        params: { relativePath: RELATIVE_PATH, mode: 'edit' }
      }
    })
    harness.client.receive(response({ opened: true, activated: false }))
    await expect(open).resolves.toBeNull()

    const refused = createHarness()
    const openRefused = refused.client.fileOpen({
      workspaceId: WORKSPACE_ID,
      relativePath: RELATIVE_PATH
    })
    refused.client.receive(response({ opened: false }))
    await expect(openRefused).rejects.toMatchObject({ code: 'invalid_message' })
  })

  it('resolves a terminal artifact without handing the page a host path', async () => {
    const harness = createHarness()
    const resolve = harness.client.fileResolveTerminalPath({
      workspaceId: WORKSPACE_ID,
      tabId: 'tab-1',
      pathText: '/tmp/report.png',
      line: null,
      column: null
    })
    expect(harness.messages.at(-1)).toMatchObject({
      capability: 'workspace',
      operation: 'hostRequest',
      payload: {
        method: 'mobileWeb.terminal.resolvePath',
        workspaceId: WORKSPACE_ID,
        params: { tabId: 'tab-1', pathText: '/tmp/report.png', line: null, column: null }
      }
    })
    harness.client.receive(
      response({
        kind: 'terminal-artifact',
        displayName: 'report.png',
        previewKind: 'raster',
        line: null,
        column: null
      })
    )
    await expect(resolve).resolves.toEqual({
      kind: 'terminal-artifact',
      workspaceId: WORKSPACE_ID,
      displayName: 'report.png',
      previewKind: 'raster',
      line: null,
      column: null
    })
  })

  it('reads a chunk by re-sending the terminal text it resolved', async () => {
    const harness = createHarness()
    const read = harness.client.fileReadTerminalArtifactChunk({
      workspaceId: WORKSPACE_ID,
      tabId: 'tab-1',
      pathText: '/tmp/report.png',
      offset: 4,
      length: 3
    })
    expect(harness.messages.at(-1)).toMatchObject({
      payload: {
        method: 'mobileWeb.terminal.artifactChunk',
        params: { tabId: 'tab-1', pathText: '/tmp/report.png', offset: 4, length: 3 }
      }
    })
    harness.client.receive(
      response({
        pathText: '/tmp/report.png',
        offset: 4,
        contentBase64: 'AAH/',
        bytesRead: 3,
        eof: true
      })
    )
    await expect(read).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      tabId: 'tab-1',
      pathText: '/tmp/report.png',
      offset: 4,
      bytes: new Uint8Array([0, 1, 255]),
      bytesRead: 3,
      eof: true
    })
  })

  it('rejects mismatched terminal artifact chunk identities and supports cancellation', async () => {
    for (const override of [{ pathText: '/tmp/other.png' }, { offset: 5 }, { bytesRead: 4 }]) {
      const harness = createHarness()
      const read = harness.client.fileReadTerminalArtifactChunk({
        workspaceId: WORKSPACE_ID,
        tabId: 'tab-1',
        pathText: '/tmp/report.png',
        offset: 4,
        length: 3
      })
      harness.client.receive(
        response({
          pathText: '/tmp/report.png',
          offset: 4,
          contentBase64: 'AAH/',
          bytesRead: 3,
          eof: true,
          ...override
        })
      )
      await expect(read).rejects.toMatchObject({
        code: 'invalid_message',
        retryable: false
      })
    }

    const harness = createHarness()
    const controller = new AbortController()
    controller.abort()
    await expect(
      harness.client.fileReadTerminalArtifactChunk(
        {
          workspaceId: WORKSPACE_ID,
          tabId: 'tab-1',
          pathText: '/tmp/report.png',
          offset: 0,
          length: 3
        },
        { signal: controller.signal }
      )
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(harness.messages).toHaveLength(0)
  })
})

function createHarness(
  grants: Extract<MobileWebBridgeShellMessage, { type: 'init' }>['grants'] = writeGrants()
) {
  const messages: MobileWebBridgePageMessage[] = []
  const client = new MobileWebBridgeClient({
    context: CONTEXT,
    grants,
    postMessage: (message) => {
      messages.push(message)
      return true
    },
    createRequestId: () => REQUEST_ID
  })
  return { client, messages }
}

function writeGrants(): Extract<MobileWebBridgeShellMessage, { type: 'init' }>['grants'] {
  return [
    {
      capability: 'workspace',
      operation: 'hostRequest',
      limits: {
        maxRequestBytes: 192 * 1024,
        maxResponseBytes: 2048,
        maxConcurrent: 1,
        rateCapacity: 3,
        rateRefillPerSecond: 0.5
      }
    }
  ]
}

function writePayload() {
  return {
    workspaceId: WORKSPACE_ID,
    relativePath: RELATIVE_PATH,
    expectedRevision: 'a'.repeat(64),
    contentBase64: CONTENT_BASE64
  }
}

function writeResult(
  overrides: Partial<{
    workspaceId: string
    relativePath: string
    revision: string
    byteLength: number
  }> = {}
) {
  return {
    workspaceId: WORKSPACE_ID,
    relativePath: RELATIVE_PATH,
    revision: REVISION,
    byteLength: CONTENT.byteLength,
    outcome: 'updated' as const,
    ...overrides
  }
}

function hostWriteResult(
  overrides: Partial<{ relativePath: string; revision: string; byteLength: number }> = {}
) {
  const { workspaceId: _workspaceId, ...result } = writeResult()
  return { ...result, ...overrides }
}

function response(payload: unknown): MobileWebBridgeShellMessage {
  return {
    version: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
    type: 'response',
    shellSessionId: CONTEXT.shellSessionId,
    buildId: CONTEXT.buildId,
    requestId: REQUEST_ID,
    status: 'success',
    payload
  }
}
