import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultScanIssue
} from '../../shared/ai-vault-types'
import { toSshExecutionHostId } from '../../shared/execution-host'
import {
  getSshFilesystemProvider,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-filesystem-dispatch'
import { getActiveSshAiVaultHostInfo, requestActiveSshAiVaultSessionList } from '../ipc/ssh'
import { isSshMuxRequestTimeoutError } from '../ssh/ssh-channel-multiplexer'
import { createAiVaultScanCancelledError } from './ai-vault-scan-cancellation'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { parseAiVaultListResult } from './session-list-result-validation'
import { aiVaultScanIssueResult, restampAiVaultListResult } from './session-list-results'

/** Bounds one SSH host leg. `relayTimeoutMs` caps the relay round trip alone;
 * `timeoutMs` caps the whole leg, including the legacy filesystem crawl. */
export type SshAiVaultScanBudget = {
  signal?: AbortSignal
  timeoutMs?: number
  relayTimeoutMs?: number
}

// Why: a relay that was given a real scan budget and still timed out will not
// answer faster over the slower filesystem crawl, so that leg reports a host
// issue. A relay cut short below this never got a fair attempt — those fall
// back rather than emptying a healthy host's sessions (#12178 follow-up).
const MEANINGFUL_RELAY_SCAN_ATTEMPT_MS = 10_000

export async function scanSshAiVaultSessions(
  targetId: string,
  args?: AiVaultListArgs,
  options: SshAiVaultScanBudget = {}
): Promise<AiVaultListResult> {
  const executionHostId = toSshExecutionHostId(targetId)
  // Why: in `all` scope every host leg is awaited together, so an unexpected
  // throw here (not a caller cancellation) would discard the local results too.
  try {
    return await scanOneSshHost(targetId, executionHostId, args, options)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    return sshScanIssueResult(executionHostId, targetId, errorMessage(error))
  }
}

async function scanOneSshHost(
  targetId: string,
  executionHostId: `ssh:${string}`,
  args: AiVaultListArgs | undefined,
  options: SshAiVaultScanBudget
): Promise<AiVaultListResult> {
  const startedAt = Date.now()
  // Both legs scan the same capped set, so the fallback can't quietly scan more
  // paths — or skip the truncation notice — than the relay leg would.
  const scopePaths = args?.scopePaths?.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT)
  const scopePathsTruncated = (args?.scopePaths?.length ?? 0) > AI_VAULT_SCOPE_PATHS_MAX_COUNT
  let relayError: unknown
  const relayTimeoutMs = options.relayTimeoutMs ?? options.timeoutMs
  try {
    const params = {
      limit: args?.limit,
      ...(args?.unlimited === true ? { unlimited: true } : {}),
      ...(args?.force === true ? { force: true } : {}),
      scopePaths,
      ...(scopePathsTruncated ? { scopePathsTruncated: true } : {})
    }
    const relayResult =
      options.signal || relayTimeoutMs !== undefined
        ? await requestActiveSshAiVaultSessionList(targetId, params, {
            signal: options.signal,
            timeoutMs: relayTimeoutMs
          })
        : await requestActiveSshAiVaultSessionList(targetId, params)
    if (relayResult !== null) {
      return restampAiVaultListResult(parseAiVaultListResult(relayResult), executionHostId)
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    if (
      isSshMuxRequestTimeoutError(error) &&
      (relayTimeoutMs === undefined || relayTimeoutMs >= MEANINGFUL_RELAY_SCAN_ATTEMPT_MS)
    ) {
      return sshScanIssueResult(executionHostId, targetId, errorMessage(error))
    }
    relayError = error
  }
  const hostInfo = getActiveSshAiVaultHostInfo(targetId)
  const provider = getSshFilesystemProvider(targetId)
  if (!hostInfo || !provider) {
    return sshScanIssueResult(
      executionHostId,
      targetId,
      relayError ? errorMessage(relayError) : SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
    )
  }
  // Why: `timeoutMs` bounded only the relay round trip, so a host on a relay
  // without the list method fell through to the unbounded desktop crawl and one
  // stalled SSH file stream could hold every other host's results hostage.
  const fallbackResult = await scanRemoteSessionsWithinBudget({
    scan: (signal) =>
      scanRemoteAiVaultSessions({
        provider,
        executionHostId,
        remoteHome: hostInfo.remoteHome,
        hostPlatform: hostInfo.hostPlatform,
        limit: args?.limit,
        unlimited: args?.unlimited,
        scopePaths,
        signal
      }),
    signal: options.signal,
    remainingMs: remainingScanBudgetMs(options.timeoutMs, startedAt)
  })
  if (!fallbackResult) {
    return sshScanIssueResult(
      executionHostId,
      targetId,
      `Agent Session History scan timed out after ${options.timeoutMs}ms on this SSH host.`
    )
  }
  const scopeIssues = scopePathsTruncated
    ? [scopeTruncationIssue(executionHostId, hostInfo.remoteHome)]
    : []
  // An empty remote home and "the relay method failed and the crawl found
  // nothing" look identical, so a fallback that recovered nothing still reports
  // the relay error instead of presenting a broken relay as an empty host.
  if (!relayError || fallbackResult.sessions.length > 0) {
    return { ...fallbackResult, issues: [...fallbackResult.issues, ...scopeIssues] }
  }
  return {
    ...fallbackResult,
    issues: [
      ...sshScanIssueResult(executionHostId, targetId, errorMessage(relayError)).issues,
      ...fallbackResult.issues,
      ...scopeIssues
    ]
  }
}

/** Budget left for the legacy crawl after the relay attempt spent part of it. */
function remainingScanBudgetMs(timeoutMs: number | undefined, startedAt: number): number | null {
  if (timeoutMs === undefined) {
    return null
  }
  return Math.max(0, timeoutMs - (Date.now() - startedAt))
}

/** Runs the legacy crawl under `remainingMs`; resolves null once the budget is
 * spent. Caller cancellation still propagates as an AbortError. */
async function scanRemoteSessionsWithinBudget(args: {
  scan: (signal?: AbortSignal) => Promise<AiVaultListResult>
  signal?: AbortSignal
  remainingMs: number | null
}): Promise<AiVaultListResult | null> {
  const remainingMs = args.remainingMs
  if (remainingMs === null) {
    return args.scan(args.signal)
  }
  if (args.signal?.aborted) {
    throw createAiVaultScanCancelledError()
  }
  if (remainingMs === 0) {
    return null
  }
  const controller = new AbortController()
  return new Promise<AiVaultListResult | null>((resolve, reject) => {
    let settled = false
    const finish = (settle: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      args.signal?.removeEventListener('abort', onCallerAbort)
      settle()
    }
    const onCallerAbort = (): void => {
      controller.abort()
      finish(() => reject(createAiVaultScanCancelledError()))
    }
    const timer = setTimeout(() => {
      controller.abort()
      finish(() => resolve(null))
    }, remainingMs)
    args.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (args.signal?.aborted) {
      onCallerAbort()
      return
    }
    try {
      const scan = args.scan(controller.signal)
      // The SSH provider may ignore abort; observe any eventual rejection after
      // this caller has already returned its timeout or cancellation result.
      void scan.then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error))
      )
    } catch (error) {
      finish(() => reject(error))
    }
  })
}

// Mirrors the notice the relay leg appends so both legs report the same cap.
function scopeTruncationIssue(
  executionHostId: `ssh:${string}`,
  remoteHome: string
): AiVaultScanIssue {
  return {
    executionHostId,
    agent: 'codex',
    kind: 'scope',
    path: remoteHome,
    message: `Only the first ${AI_VAULT_SCOPE_PATHS_MAX_COUNT} project paths were scanned.`
  }
}

function sshScanIssueResult(
  executionHostId: `ssh:${string}`,
  targetId: string,
  message: string
): AiVaultListResult {
  return aiVaultScanIssueResult({ executionHostId, path: targetId, message })
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : 'Agent Session History scan failed on the SSH target.'
}
