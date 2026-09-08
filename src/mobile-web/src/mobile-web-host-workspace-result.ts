import { MobileWebBridgeClientError } from './mobile-web-bridge-client-error'

/** A host-lane result carries no workspace handle: the shell addressed the Desktop by worktree, so
 * the page restores the handle it asked with before the contract schema parses the result. */
export function withPageWorkspaceId(result: unknown, workspaceId: string): Record<string, unknown> {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) {
    throw new MobileWebBridgeClientError('invalid_message', false)
  }
  return { ...(result as Record<string, unknown>), workspaceId }
}
