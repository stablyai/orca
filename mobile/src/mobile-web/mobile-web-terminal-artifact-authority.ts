import {
  MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS,
  MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES,
  MOBILE_WEB_TERMINAL_ARTIFACT_TEXT_MAX_BYTES,
  MOBILE_WEB_TERMINAL_ARTIFACT_TTL_MS,
  MobileWebTerminalArtifactChunkPayloadSchema,
  MobileWebTerminalArtifactChunkResultSchema,
  MobileWebTerminalArtifactReleasePayloadSchema,
  MobileWebTerminalPathResolvePayloadSchema,
  MobileWebTerminalPathResolveResultSchema,
  type MobileWebTerminalArtifactChunkWireResult,
  type MobileWebTerminalPathResolveResult
} from '../../../src/shared/mobile-web/terminal-artifact-contract'
import { MobileWebRelativePathSchema } from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { encodeMobileWebBase64UrlToken } from './mobile-web-base64url-token'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'
import { terminalArtifactFailureCode } from './mobile-web-terminal-artifact-host-error'
import {
  displayNameFromTerminalArtifactPath,
  terminalArtifactPreviewKind
} from './mobile-web-terminal-artifact-presentation'
import { resolveActiveMobileWebTerminal } from './mobile-web-terminal-resolution'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

type ArtifactRecord = {
  token: string
  pageWorkspaceId: string
  hostWorkspaceId: string
  tabId: string
  terminal: string
  absolutePath: string
  grantId: string
  previewKind: 'text' | 'raster'
  client: RpcClient
  expiresAt: number
}

export class MobileWebTerminalArtifactAuthority {
  private readonly records = new Map<string, ArtifactRecord>()
  private readonly now: () => number
  private readonly randomBytes: (length: number) => Uint8Array
  private generation = 0

  constructor(options: { now?: () => number; randomBytes: (length: number) => Uint8Array }) {
    this.now = options.now ?? Date.now
    this.randomBytes = options.randomBytes
  }

  async resolve(
    payloadValue: unknown,
    client: RpcClient,
    workspaceAuthority: MobileWebWorkspaceAuthority
  ): Promise<MobileWebTerminalPathResolveResult> {
    const payload = MobileWebTerminalPathResolvePayloadSchema.parse(payloadValue)
    const hostWorkspaceId = workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    const generation = this.generation
    const terminal = await resolveActiveMobileWebTerminal(client, hostWorkspaceId, payload.tabId)
    this.assertGeneration(generation)
    const response = await client.sendRequest(
      'files.resolveTerminalPath',
      {
        worktree: `id:${hostWorkspaceId}`,
        pathText: payload.pathText,
        terminal
      },
      { timeoutMs: 10_000 }
    )
    this.assertGeneration(generation)
    if (!response.ok) {
      throw mobileWebBrokerHostRpcError(response.error)
    }
    const resolved = response.result
    if (
      !isRecord(resolved) ||
      resolved.worktree !== hostWorkspaceId ||
      resolved.exists !== true ||
      resolved.isDirectory !== false ||
      !isRecord(resolved.openTarget)
    ) {
      throw new MobileWebBrokerError('not_found')
    }
    if (resolved.openTarget.kind === 'worktree-file') {
      return this.worktreeResult(payload, resolved.openTarget)
    }
    if (resolved.openTarget.kind !== 'absolute-file') {
      throw new MobileWebBrokerError('not_found')
    }
    return this.retainArtifact(payload, hostWorkspaceId, resolved.openTarget, terminal, client)
  }

  async readChunk(
    payloadValue: unknown,
    client: RpcClient
  ): Promise<MobileWebTerminalArtifactChunkWireResult> {
    const payload = MobileWebTerminalArtifactChunkPayloadSchema.parse(payloadValue)
    const record = this.requireRecord(payload, client)
    const maxBytes =
      record.previewKind === 'raster'
        ? MOBILE_WEB_TERMINAL_ARTIFACT_RASTER_MAX_BYTES
        : MOBILE_WEB_TERMINAL_ARTIFACT_TEXT_MAX_BYTES
    if (payload.offset >= maxBytes || payload.length > maxBytes - payload.offset) {
      throw new MobileWebBrokerError('too_large')
    }
    const activeTerminal = await resolveActiveMobileWebTerminal(
      client,
      record.hostWorkspaceId,
      record.tabId
    ).catch(() => null)
    if (activeTerminal !== record.terminal || this.records.get(record.token) !== record) {
      this.records.delete(record.token)
      throw new MobileWebBrokerError('not_found')
    }
    const response = await client.sendRequest(
      'files.readTerminalArtifactChunk',
      {
        worktree: `id:${record.hostWorkspaceId}`,
        grantId: record.grantId,
        absolutePath: record.absolutePath,
        offset: payload.offset,
        length: payload.length,
        maxBytes
      },
      { timeoutMs: 15_000 }
    )
    if (this.records.get(record.token) !== record) {
      throw new MobileWebBrokerError('not_found')
    }
    if (!response.ok) {
      this.records.delete(record.token)
      throw new MobileWebBrokerError(terminalArtifactFailureCode(response.error))
    }
    if (!isRecord(response.result)) {
      this.records.delete(record.token)
      throw new MobileWebBrokerError('host_error')
    }
    const result = MobileWebTerminalArtifactChunkResultSchema.safeParse({
      workspaceId: record.pageWorkspaceId,
      tabId: record.tabId,
      token: record.token,
      offset: payload.offset,
      contentBase64: response.result.contentBase64,
      bytesRead: response.result.bytesRead,
      eof: response.result.eof
    })
    if (!result.success) {
      this.records.delete(record.token)
      throw new MobileWebBrokerError('host_error')
    }
    if (
      result.data.bytesRead > payload.length ||
      (!result.data.eof && result.data.bytesRead !== payload.length)
    ) {
      this.records.delete(record.token)
      throw new MobileWebBrokerError('host_error')
    }
    record.expiresAt = this.now() + MOBILE_WEB_TERMINAL_ARTIFACT_TTL_MS
    return result.data
  }

  release(payloadValue: unknown): null {
    const payload = MobileWebTerminalArtifactReleasePayloadSchema.parse(payloadValue)
    const record = this.records.get(payload.token)
    if (
      record &&
      record.pageWorkspaceId === payload.workspaceId &&
      record.tabId === payload.tabId
    ) {
      this.records.delete(payload.token)
    }
    return null
  }

  clear(): void {
    this.records.clear()
    this.generation += 1
  }

  sizeForTests(): number {
    this.pruneExpired()
    return this.records.size
  }

  private worktreeResult(
    payload: {
      workspaceId: string
      line: number | null
      column: number | null
    },
    openTarget: Record<string, unknown>
  ): MobileWebTerminalPathResolveResult {
    const relativePath = MobileWebRelativePathSchema.safeParse(openTarget.relativePath)
    if (!relativePath.success) {
      throw new MobileWebBrokerError('host_error')
    }
    return MobileWebTerminalPathResolveResultSchema.parse({
      kind: 'worktree-file',
      workspaceId: payload.workspaceId,
      relativePath: relativePath.data,
      displayName: displayNameFromTerminalArtifactPath(relativePath.data),
      previewKind: terminalArtifactPreviewKind(relativePath.data),
      line: payload.line,
      column: payload.column
    })
  }

  private retainArtifact(
    payload: {
      workspaceId: string
      tabId: string
      line: number | null
      column: number | null
    },
    hostWorkspaceId: string,
    openTarget: Record<string, unknown>,
    terminal: string,
    client: RpcClient
  ): MobileWebTerminalPathResolveResult {
    if (
      typeof openTarget.absolutePath !== 'string' ||
      openTarget.absolutePath.length < 1 ||
      openTarget.absolutePath.length > 4096 ||
      typeof openTarget.grantId !== 'string' ||
      openTarget.grantId.length < 1 ||
      openTarget.grantId.length > 256
    ) {
      throw new MobileWebBrokerError('host_error')
    }
    this.pruneExpired()
    for (const [token, record] of this.records) {
      if (record.pageWorkspaceId === payload.workspaceId && record.tabId === payload.tabId) {
        this.records.delete(token)
      }
    }
    while (this.records.size >= MOBILE_WEB_TERMINAL_ARTIFACT_MAX_RECORDS) {
      const oldest = this.records.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      this.records.delete(oldest)
    }
    const token = this.createToken()
    const displayName = displayNameFromTerminalArtifactPath(openTarget.absolutePath)
    const previewKind = terminalArtifactPreviewKind(openTarget.absolutePath)
    this.records.set(token, {
      token,
      pageWorkspaceId: payload.workspaceId,
      hostWorkspaceId,
      tabId: payload.tabId,
      terminal,
      absolutePath: openTarget.absolutePath,
      grantId: openTarget.grantId,
      previewKind,
      client,
      expiresAt: this.now() + MOBILE_WEB_TERMINAL_ARTIFACT_TTL_MS
    })
    return MobileWebTerminalPathResolveResultSchema.parse({
      kind: 'terminal-artifact',
      workspaceId: payload.workspaceId,
      token,
      displayName,
      previewKind,
      line: payload.line,
      column: payload.column
    })
  }

  private requireRecord(
    payload: { token: string; workspaceId: string; tabId: string },
    client: RpcClient
  ): ArtifactRecord {
    this.pruneExpired()
    const record = this.records.get(payload.token)
    if (
      !record ||
      record.client !== client ||
      record.pageWorkspaceId !== payload.workspaceId ||
      record.tabId !== payload.tabId
    ) {
      throw new MobileWebBrokerError('not_found')
    }
    return record
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [token, record] of this.records) {
      if (record.expiresAt <= now) {
        this.records.delete(token)
      }
    }
  }

  private createToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = encodeMobileWebBase64UrlToken(this.randomBytes(32))
      if (!this.records.has(token)) {
        return token
      }
    }
    throw new MobileWebBrokerError('internal')
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw new MobileWebBrokerError('not_found')
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
