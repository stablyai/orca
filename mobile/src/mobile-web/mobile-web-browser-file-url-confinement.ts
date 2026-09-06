import { fileUriToFilesystemPath, filesystemPathToFileUri } from '../../../src/shared/file-uri-path'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'

const RESOLVE_TIMEOUT_MS = 10_000

export function isMobileWebBrowserFileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'file:'
  } catch {
    return false
  }
}

/**
 * The hosted page is untrusted, so a `file:` browser create it asks for is only honoured when the
 * host itself resolves the path back to a file inside that workspace's root. The returned URL is
 * rebuilt from the host's own absolute path, so nothing the page wrote reaches `browser.tabCreate`.
 */
export async function confineMobileWebBrowserFileUrl(args: {
  url: string
  hostWorkspaceId: string
  client: RpcClient
}): Promise<string> {
  let pathText: string
  try {
    pathText = fileUriToFilesystemPath(new URL(args.url)) ?? ''
  } catch {
    throw new MobileWebBrokerError('invalid_request')
  }
  if (!pathText) {
    throw new MobileWebBrokerError('invalid_request')
  }
  const response = await args.client.sendRequest(
    'files.resolveTerminalPath',
    { worktree: `id:${args.hostWorkspaceId}`, pathText },
    { timeoutMs: RESOLVE_TIMEOUT_MS }
  )
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  const resolved = response.result
  if (
    !isRecord(resolved) ||
    resolved.worktree !== args.hostWorkspaceId ||
    resolved.exists !== true ||
    resolved.isDirectory !== false ||
    !isRecord(resolved.openTarget) ||
    resolved.openTarget.kind !== 'worktree-file' ||
    // Why: browser.tabCreate opens the URL on the runtime host, so an SSH worktree's path would
    // name an unrelated local file (or none) on the desktop that renders it.
    resolved.openTarget.provider !== 'local' ||
    typeof resolved.openTarget.absolutePath !== 'string' ||
    resolved.openTarget.absolutePath.length < 1 ||
    resolved.openTarget.absolutePath.length > 4096
  ) {
    throw new MobileWebBrokerError('invalid_request')
  }
  return filesystemPathToFileUri(resolved.openTarget.absolutePath)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
