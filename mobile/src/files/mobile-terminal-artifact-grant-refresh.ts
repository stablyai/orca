import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import { isTerminalArtifactGrantError } from './terminal-artifact-grant-error'

type MobileFilePreviewClient = Pick<RpcClient, 'sendRequest'>

export type MobileTerminalArtifactPreviewSource = {
  source: 'terminalArtifact'
  worktreeId: string
  absolutePath: string
  grantId: string
  terminalHandle?: string
  pathText?: string
  cwd?: string
}

export type TerminalArtifactRetryOptions = {
  onTerminalArtifactSourceRefreshed?: (source: MobileTerminalArtifactPreviewSource) => void
  refreshGrant?: boolean
}

export async function refreshTerminalArtifactSourceAfterGrantFailure(
  client: MobileFilePreviewClient,
  source: MobileTerminalArtifactPreviewSource,
  response: RpcResponse,
  options: TerminalArtifactRetryOptions = {}
): Promise<MobileTerminalArtifactPreviewSource | null> {
  if (response.ok || !isTerminalArtifactGrantFailure(response, options)) {
    return null
  }
  const refreshed = await client.sendRequest('files.resolveTerminalPath', {
    worktree: `id:${source.worktreeId}`,
    pathText: source.pathText ?? source.absolutePath,
    ...(source.cwd ? { cwd: source.cwd } : {}),
    ...(source.terminalHandle ? { terminal: source.terminalHandle } : {})
  })
  if (!refreshed.ok) {
    return null
  }
  const result = (refreshed as RpcSuccess).result
  if (!isTerminalArtifactResolution(result)) {
    return null
  }
  if (result.openTarget.absolutePath !== source.absolutePath) {
    return null
  }
  return {
    source: 'terminalArtifact',
    worktreeId: source.worktreeId,
    absolutePath: result.openTarget.absolutePath,
    grantId: result.openTarget.grantId,
    ...(source.terminalHandle ? { terminalHandle: source.terminalHandle } : {}),
    ...(source.pathText ? { pathText: source.pathText } : {}),
    ...(source.cwd ? { cwd: source.cwd } : {})
  }
}

function isTerminalArtifactGrantFailure(
  response: RpcFailure,
  options: TerminalArtifactRetryOptions
): boolean {
  if (options.refreshGrant === false) {
    return false
  }
  return isTerminalArtifactGrantError(`${response.error.code} ${response.error.message}`)
}

function isTerminalArtifactResolution(result: unknown): result is {
  exists: true
  isDirectory: false
  openTarget: { kind: 'absolute-file'; absolutePath: string; grantId: string }
} {
  if (!result || typeof result !== 'object') {
    return false
  }
  const resolution = result as {
    exists?: unknown
    isDirectory?: unknown
    openTarget?: { kind?: unknown; absolutePath?: unknown; grantId?: unknown }
  }
  return (
    resolution.exists === true &&
    resolution.isDirectory === false &&
    resolution.openTarget?.kind === 'absolute-file' &&
    typeof resolution.openTarget.absolutePath === 'string' &&
    typeof resolution.openTarget.grantId === 'string'
  )
}
