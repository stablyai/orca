import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS,
  MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES,
  MOBILE_WEB_TERMINAL_ARTIFACT_TEXT_MAX_BYTES,
  MOBILE_WEB_TERMINAL_ARTIFACT_TTL_MS,
  type MobileWebTerminalPathResolveResult
} from '../../../src/shared/mobile-web/terminal-artifact-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebTerminalArtifactAuthority } from './mobile-web-terminal-artifact-authority'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const HOST_WORKSPACE_ID = 'repo::/private/repo'
const WORKSPACE_ID = `workspace_0_${'07'.repeat(16)}`
const TAB_ID = 'tab-1'

describe('MobileWebTerminalArtifactAuthority', () => {
  it('returns only a safe relative identity for worktree files', async () => {
    const harness = createClientHarness()
    harness.state.target = {
      kind: 'worktree-file',
      relativePath: 'src/app.ts',
      absolutePath: '/private/repo/src/app.ts',
      grantId: 'must-not-cross'
    }
    const authority = createAuthority()

    const result = await resolveArtifact(authority, resolvePayload(), harness.client)

    expect(result).toEqual({
      kind: 'worktree-file',
      workspaceId: WORKSPACE_ID,
      relativePath: 'src/app.ts',
      displayName: 'app.ts',
      previewKind: 'text',
      line: 4,
      column: 2
    })
    expect(JSON.stringify(result)).not.toContain('/private')
    expect(JSON.stringify(result)).not.toContain('grant')
    expect(authority.sizeForTests()).toBe(0)
  })

  it('keeps absolute paths, grants, and provider identity private while reading exact chunks', async () => {
    const harness = createClientHarness()
    harness.state.target = absoluteTarget('/private/ssh/results/report.png', 'desktop-grant', {
      provider: 'ssh',
      connectionId: 'provider-target',
      expectedStatIdentity: '1:2:3'
    })
    const authority = createAuthority()

    const result = await resolveArtifact(authority, resolvePayload(), harness.client)
    const token = artifactToken(result)

    expect(result).toMatchObject({
      kind: 'terminal-artifact',
      workspaceId: WORKSPACE_ID,
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      displayName: 'report.png',
      previewKind: 'raster'
    })
    expect(JSON.stringify(result)).not.toMatch(
      /private|desktop-grant|provider-target|expectedStatIdentity|ssh/
    )

    await expect(authority.readChunk(chunkPayload(token), harness.client)).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      tabId: TAB_ID,
      token,
      offset: 0,
      contentBase64: 'AQI=',
      bytesRead: 2,
      eof: true
    })
    expect(harness.sendRequest).toHaveBeenCalledWith(
      'files.readTerminalArtifactChunk',
      {
        worktree: `id:${HOST_WORKSPACE_ID}`,
        grantId: 'desktop-grant',
        absolutePath: '/private/ssh/results/report.png',
        offset: 0,
        length: 2,
        maxBytes: MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES
      },
      { timeoutMs: 15_000 }
    )
  })

  it('rejects token replay across clients, workspaces, and tabs before reading the host', async () => {
    const owner = createClientHarness()
    const other = createClientHarness()
    const authority = createAuthority()
    const token = artifactToken(await resolveArtifact(authority, resolvePayload(), owner.client))

    for (const [payload, client] of [
      [{ ...chunkPayload(token), workspaceId: 'workspace-2' }, owner.client],
      [{ ...chunkPayload(token), tabId: 'tab-2' }, owner.client],
      [chunkPayload(token), other.client]
    ] as const) {
      await expect(authority.readChunk(payload, client)).rejects.toMatchObject({
        code: 'not_found'
      })
    }
    expect(hostChunkCalls(owner.sendRequest)).toHaveLength(0)
    expect(hostChunkCalls(other.sendRequest)).toHaveLength(0)
  })

  it('revokes a token when its terminal is no longer the active exact terminal', async () => {
    const harness = createClientHarness()
    const authority = createAuthority()
    const token = artifactToken(await resolveArtifact(authority, resolvePayload(), harness.client))
    harness.state.terminal = 'replacement-terminal'

    await expect(authority.readChunk(chunkPayload(token), harness.client)).rejects.toMatchObject({
      code: 'not_found'
    })
    expect(authority.sizeForTests()).toBe(0)
    expect(hostChunkCalls(harness.sendRequest)).toHaveLength(0)
  })

  it('expires tokens without contacting the host', async () => {
    let now = 10
    const harness = createClientHarness()
    const authority = createAuthority(() => now)
    const token = artifactToken(await resolveArtifact(authority, resolvePayload(), harness.client))
    now += MOBILE_WEB_TERMINAL_ARTIFACT_TTL_MS

    await expect(authority.readChunk(chunkPayload(token), harness.client)).rejects.toMatchObject({
      code: 'not_found'
    })
    expect(hostChunkCalls(harness.sendRequest)).toHaveLength(0)
  })

  it('replaces an older token for the same terminal tab', async () => {
    const harness = createClientHarness()
    const authority = createAuthority()
    const first = artifactToken(await resolveArtifact(authority, resolvePayload(), harness.client))
    harness.state.target = absoluteTarget('/private/results/second.txt', 'grant-2')
    const second = artifactToken(await resolveArtifact(authority, resolvePayload(), harness.client))

    expect(second).not.toBe(first)
    expect(authority.sizeForTests()).toBe(1)
    await expect(authority.readChunk(chunkPayload(first), harness.client)).rejects.toMatchObject({
      code: 'not_found'
    })
    await expect(authority.readChunk(chunkPayload(second), harness.client)).resolves.toMatchObject({
      token: second
    })
  })

  it('evicts the oldest token when the registry reaches its hard limit', async () => {
    const harness = createClientHarness()
    const authority = createAuthority()
    const tokens: string[] = []

    for (let index = 0; index <= MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS; index += 1) {
      harness.state.activeTabId = `tab-${index}`
      harness.state.terminal = `terminal-${index}`
      harness.state.target = absoluteTarget(`/private/results/${index}.txt`, `grant-${index}`)
      tokens.push(
        artifactToken(
          await resolveArtifact(
            authority,
            resolvePayload({ tabId: harness.state.activeTabId }),
            harness.client
          )
        )
      )
    }

    expect(authority.sizeForTests()).toBe(MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS)
    await expect(
      authority.readChunk(chunkPayload(tokens[0], { tabId: 'tab-0' }), harness.client)
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      authority.readChunk(
        chunkPayload(tokens.at(-1)!, {
          tabId: `tab-${MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS}`
        }),
        harness.client
      )
    ).resolves.toMatchObject({ token: tokens.at(-1) })
  })

  it('revokes failed Desktop grants and exposes only a stable error', async () => {
    const harness = createClientHarness()
    const authority = createAuthority()
    const token = artifactToken(await resolveArtifact(authority, resolvePayload(), harness.client))
    harness.state.chunkResponse = {
      ok: false,
      error: {
        code: 'terminal_file_grant_expired',
        message: 'No such file: /private/results/report.txt'
      }
    }

    await expect(authority.readChunk(chunkPayload(token), harness.client)).rejects.toMatchObject({
      code: 'not_found',
      message: 'not_found'
    })
    expect(authority.sizeForTests()).toBe(0)
  })

  it('enforces text and raster total bounds before host reads', async () => {
    const harness = createClientHarness()
    const authority = createAuthority()
    const textToken = artifactToken(
      await resolveArtifact(authority, resolvePayload(), harness.client)
    )

    await expect(
      authority.readChunk(
        chunkPayload(textToken, {
          offset: MOBILE_WEB_TERMINAL_ARTIFACT_TEXT_MAX_BYTES - 1,
          length: 2
        }),
        harness.client
      )
    ).rejects.toMatchObject({ code: 'too_large' })

    harness.state.target = absoluteTarget('/private/results/image.png', 'image-grant')
    const rasterToken = artifactToken(
      await resolveArtifact(authority, resolvePayload(), harness.client)
    )
    await expect(
      authority.readChunk(
        chunkPayload(rasterToken, {
          offset: MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES - 1,
          length: 2
        }),
        harness.client
      )
    ).rejects.toMatchObject({ code: 'too_large' })
    expect(hostChunkCalls(harness.sendRequest)).toHaveLength(0)
  })

  it('fails closed on malformed or overlong host chunks', async () => {
    const harness = createClientHarness()
    const authority = createAuthority()
    const malformedResults = [
      { contentBase64: 'AQID', bytesRead: 3, eof: true },
      { contentBase64: 'AQ==', bytesRead: 1, eof: false },
      { contentBase64: 'AB==', bytesRead: 1, eof: true }
    ]

    for (const [index, result] of malformedResults.entries()) {
      harness.state.target = absoluteTarget(`/private/results/${index}.txt`, `grant-${index}`)
      harness.state.chunkResponse = { ok: true, result }
      const token = artifactToken(
        await resolveArtifact(authority, resolvePayload(), harness.client)
      )
      await expect(authority.readChunk(chunkPayload(token), harness.client)).rejects.toMatchObject({
        code: 'host_error'
      })
      expect(authority.sizeForTests()).toBe(0)
    }
  })

  it('supports explicit release and broker-wide cleanup', async () => {
    const harness = createClientHarness()
    const authority = createAuthority()
    const first = artifactToken(await resolveArtifact(authority, resolvePayload(), harness.client))

    expect(authority.release({ workspaceId: WORKSPACE_ID, tabId: TAB_ID, token: first })).toBeNull()
    expect(authority.sizeForTests()).toBe(0)

    harness.state.activeTabId = 'tab-2'
    harness.state.terminal = 'terminal-2'
    await resolveArtifact(authority, resolvePayload({ tabId: 'tab-2' }), harness.client)
    expect(authority.sizeForTests()).toBe(1)
    authority.clear()
    expect(authority.sizeForTests()).toBe(0)
  })
})

type ClientHarnessState = {
  activeTabId: string
  terminal: string
  target: Record<string, unknown>
  chunkResponse:
    | { ok: true; result: unknown }
    | { ok: false; error: { code: string; message: string } }
}

function createClientHarness(): {
  client: RpcClient
  sendRequest: ReturnType<typeof vi.fn>
  state: ClientHarnessState
} {
  const state: ClientHarnessState = {
    activeTabId: TAB_ID,
    terminal: 'terminal-handle-1',
    target: absoluteTarget('/private/results/report.txt', 'grant-1'),
    chunkResponse: {
      ok: true,
      result: { contentBase64: 'AQI=', bytesRead: 2, eof: true }
    }
  }
  const sendRequest = vi.fn(async (method: string) => {
    if (method === 'session.tabs.list') {
      return {
        ok: true,
        result: {
          worktree: HOST_WORKSPACE_ID,
          activeTabId: state.activeTabId,
          tabs: [
            {
              id: state.activeTabId,
              type: 'terminal',
              status: 'ready',
              terminal: state.terminal,
              isActive: true
            }
          ]
        }
      }
    }
    if (method === 'files.resolveTerminalPath') {
      return {
        ok: true,
        result: {
          worktree: HOST_WORKSPACE_ID,
          exists: true,
          isDirectory: false,
          openTarget: state.target
        }
      }
    }
    if (method === 'files.readTerminalArtifactChunk') {
      return state.chunkResponse
    }
    throw new Error(`Unexpected method: ${method}`)
  })
  return {
    client: { sendRequest } as unknown as RpcClient,
    sendRequest,
    state
  }
}

function createAuthority(now?: () => number): MobileWebTerminalArtifactAuthority {
  let nonce = 0
  return new MobileWebTerminalArtifactAuthority({
    now,
    randomBytes: (length) => new Uint8Array(length).fill(++nonce)
  })
}

function resolveArtifact(
  authority: MobileWebTerminalArtifactAuthority,
  payload: ReturnType<typeof baseResolvePayload>,
  client: RpcClient
) {
  const workspaceAuthority = new MobileWebWorkspaceAuthority(() => new Uint8Array(16).fill(7))
  workspaceAuthority.synchronize([{ workspaceId: HOST_WORKSPACE_ID, repoId: '/private/repo' }])
  return authority.resolve(payload, client, workspaceAuthority)
}

function resolvePayload(overrides: Partial<ReturnType<typeof baseResolvePayload>> = {}) {
  return { ...baseResolvePayload(), ...overrides }
}

function baseResolvePayload() {
  return {
    workspaceId: WORKSPACE_ID,
    tabId: TAB_ID,
    pathText: '/private/results/report.txt',
    line: 4,
    column: 2
  }
}

function chunkPayload(
  token: string,
  overrides: Partial<{
    workspaceId: string
    tabId: string
    offset: number
    length: number
  }> = {}
) {
  return {
    workspaceId: WORKSPACE_ID,
    tabId: TAB_ID,
    token,
    offset: 0,
    length: 2,
    ...overrides
  }
}

function absoluteTarget(
  absolutePath: string,
  grantId: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    kind: 'absolute-file',
    absolutePath,
    grantId,
    ...extra
  }
}

function artifactToken(result: MobileWebTerminalPathResolveResult): string {
  if (result.kind !== 'terminal-artifact') {
    throw new Error('Expected a terminal artifact')
  }
  return result.token
}

function hostChunkCalls(sendRequest: ReturnType<typeof vi.fn>) {
  return sendRequest.mock.calls.filter(([method]) => method === 'files.readTerminalArtifactChunk')
}
