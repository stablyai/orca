import {
  isCodexAppServerUnsupportedError,
  type CodexHookTrustGrantRequest,
  type CodexHookTrustGrantSessionResult
} from './codex-app-server-client'
import type {
  CodexUserHookTrustRebaseRequest,
  CodexUserHookTrustRebaseResult
} from './codex-user-hook-trust-rebase-client'

export type CodexAppServerEntryRequest =
  | CodexHookTrustGrantRequest
  | CodexUserHookTrustRebaseRequest

export type CodexAppServerEntryResult =
  | CodexHookTrustGrantSessionResult
  | CodexUserHookTrustRebaseResult

export type GrantEntryEnvelope =
  | { ok: true; result: CodexAppServerEntryResult }
  | { ok: false; errorName: string; message: string; unsupported?: boolean }

export function buildGrantEntryEnvelope(
  run: Promise<CodexAppServerEntryResult>
): Promise<GrantEntryEnvelope> {
  return run.then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({
      ok: false as const,
      errorName: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      ...(isCodexAppServerUnsupportedError(error) ? { unsupported: true as const } : {})
    })
  )
}
