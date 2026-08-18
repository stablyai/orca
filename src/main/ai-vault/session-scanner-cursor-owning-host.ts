import { aiVaultScanLimit } from '../../shared/ai-vault-session-depth'
import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { withSpan } from '../observability/tracer'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { sessionSortTime } from './session-scanner-accumulator'
import { processLocalCursorCandidates } from './session-scanner-cursor-local-pipeline'
import { recordLocalCursorDiscoverySpan } from './session-scanner-cursor-observability'
import { resolveCursorOwningHostRoots } from './session-scanner-cursor-paths'
import { cursorDiscoveries } from './session-scanner-cursor-sources'
import { createSessionParseStats } from './session-scanner-parse-cache'
import type {
  AiVaultScanOptions,
  SessionFileCandidate,
  SessionFileDiscovery
} from './session-scanner-types'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'

export async function scanCursorSessionsOnOwningHost(args: {
  executionHostId: ExecutionHostId
  remoteHome: string
  hostPlatform: RemoteHostPlatform
  limit?: number
  unlimited?: boolean
  scopePaths?: readonly string[]
  signal?: AbortSignal
}): Promise<AiVaultListResult> {
  return withSpan('aiVault.cursorOwningHostScan', async (span) => {
    const limit = aiVaultScanLimit(args)
    const issues: AiVaultScanIssue[] = []
    const options = cursorHostScanOptions(args)
    const discoveryLimit = args.unlimited ? Number.POSITIVE_INFINITY : limit * 2
    const discoveries = await Promise.all(
      cursorDiscoveries(options, [], discoveryLimit, issues, { reportMissingSidecarRoot: true })
    )
    throwIfAiVaultScanCancelled(args.signal)
    const candidates = cursorCandidates(discoveries)
    const reconciled = await processLocalCursorCandidates({
      candidates,
      limit,
      scopeLimit: limit,
      platform: args.hostPlatform.os,
      executionHostId: args.executionHostId,
      issues,
      parseStats: createSessionParseStats(),
      span,
      discoveries,
      signal: args.signal
    })
    recordLocalCursorDiscoverySpan(span, discoveries)
    throwIfAiVaultScanCancelled(args.signal)
    return {
      sessions: retainCappedAndScopedSessions(
        reconciled.sessions,
        reconciled.scopedSessionIds,
        limit
      ),
      issues: issues.map((issue) => ({ executionHostId: args.executionHostId, ...issue })),
      scannedAt: new Date().toISOString()
    }
  })
}

function cursorHostScanOptions(
  args: Parameters<typeof scanCursorSessionsOnOwningHost>[0]
): AiVaultScanOptions {
  const roots = resolveCursorOwningHostRoots(args.remoteHome)
  return {
    cursorChatsDir: roots.chatsDir,
    cursorProjectsDir: roots.projectsDir,
    scopePaths: args.scopePaths,
    platform: args.hostPlatform.os,
    executionHostId: args.executionHostId,
    signal: args.signal
  }
}

function cursorCandidates(discoveries: readonly SessionFileDiscovery[]): SessionFileCandidate[] {
  return discoveries
    .flatMap((discovery) =>
      discovery.files.map(
        (file): SessionFileCandidate => ({
          agent: 'cursor',
          file,
          codexHome: null,
          cursorLayout: discovery.cursorLayout,
          cursorStorageContextKey: discovery.cursorStorageContextKey,
          cursorTargetPlatform: discovery.cursorTargetPlatform,
          cursorCwdEvidence: discovery.cursorCwdEvidenceByPath?.get(file.path),
          cursorExpectedRootRealPath: discovery.cursorExpectedRootRealPath
        })
      )
    )
    .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs)
}

function retainCappedAndScopedSessions(
  sessions: readonly AiVaultSession[],
  scopedSessionIds: ReadonlySet<string>,
  limit: number
): AiVaultSession[] {
  const ranked = [...sessions].sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
  const retained = new Map<string, AiVaultSession>()
  for (const session of ranked) {
    if (scopedSessionIds.has(session.id) && retained.size < limit) {
      retained.set(session.id, session)
    }
  }
  for (const session of ranked) {
    if (retained.size >= limit) {
      break
    }
    retained.set(session.id, session)
  }
  return [...retained.values()].sort(
    (left, right) => sessionSortTime(right) - sessionSortTime(left)
  )
}
