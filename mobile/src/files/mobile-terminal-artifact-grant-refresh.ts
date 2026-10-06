import type { RuntimeNativeChatFileContext } from '../../../src/shared/runtime-types'
import type { RpcFailure } from '../transport/types'
import {
  terminalArtifactPathResolve,
  type MobileFilePreviewRpcSender
} from './mobile-file-preview-operations'
import { isTerminalArtifactGrantError } from './terminal-artifact-grant-error'

export type MobileTerminalArtifactPreviewSource = {
  source: 'terminalArtifact'
  worktreeId: string
  absolutePath: string
  grantId: string
  terminalHandle?: string
  pathText?: string
  cwd?: string
  nativeChatContext?: RuntimeNativeChatFileContext
  readOnly?: true
}

export type TerminalArtifactRetryOptions = {
  onTerminalArtifactSourceRefreshed?: (source: MobileTerminalArtifactPreviewSource) => void
  refreshGrant?: boolean
}

/** Takes the refusal rather than the envelope: every caller already routed on its own acceptance. */
export async function refreshTerminalArtifactSourceAfterGrantFailure(
  client: MobileFilePreviewRpcSender,
  source: MobileTerminalArtifactPreviewSource,
  refusal: RpcFailure['error'],
  options: TerminalArtifactRetryOptions = {}
): Promise<MobileTerminalArtifactPreviewSource | null> {
  if (!isTerminalArtifactGrantFailure(refusal, options)) {
    return null
  }
  const reply = await terminalArtifactPathResolve.request(client, {
    worktree: `id:${source.worktreeId}`,
    pathText: source.pathText ?? source.absolutePath,
    ...(source.cwd ? { cwd: source.cwd } : {}),
    ...(source.terminalHandle ? { terminal: source.terminalHandle } : {}),
    ...(source.nativeChatContext ? { nativeChatContext: source.nativeChatContext } : {})
  })
  const resolved = terminalArtifactPathResolve.interpret(reply)
  if (!resolved.accepted) {
    return null
  }
  const result = resolved.value
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
    ...(source.cwd ? { cwd: source.cwd } : {}),
    ...(source.nativeChatContext ? { nativeChatContext: source.nativeChatContext } : {}),
    ...(source.readOnly || result.openTarget.readOnly === true ? { readOnly: true as const } : {})
  }
}

function isTerminalArtifactGrantFailure(
  refusal: RpcFailure['error'],
  options: TerminalArtifactRetryOptions
): boolean {
  if (options.refreshGrant === false) {
    return false
  }
  return isTerminalArtifactGrantError(`${refusal.code} ${refusal.message}`)
}

function isTerminalArtifactResolution(result: unknown): result is {
  exists: true
  isDirectory: false
  openTarget: { kind: 'absolute-file'; absolutePath: string; grantId: string; readOnly?: true }
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
