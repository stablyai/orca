import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  cursorSidecarScanResponseSchema,
  defaultCursorSidecarScanRequest,
  type CursorSidecarScanResponse
} from '../../shared/cursor-sidecar-scan'
import { joinRemotePath } from '../ssh/ssh-remote-platform'
import type {
  RemoteScannerContext,
  RemoteSessionCandidate,
  RemoteSessionSource
} from './remote-session-scanner-types'
import type { FileWithMtime } from './session-scanner-types'
import { errorMessage } from './session-scanner-values'
import {
  cursorBucketForCwd,
  cursorLegacySlug,
  isAbsoluteCursorTargetPath
} from './session-scanner-cursor-paths'

export type RemoteCursorSidecarDiscovery = {
  candidates: RemoteSessionCandidate[]
  scan: CursorSidecarScanResponse | null
}

export async function discoverRemoteCursorSidecars(args: {
  remoteHome: string
  context: RemoteScannerContext
  scopePaths: readonly string[]
  issues: AiVaultScanIssue[]
  signal?: AbortSignal
}): Promise<RemoteCursorSidecarDiscovery> {
  const chatsRoot = joinRemotePath(args.context.hostPlatform, args.remoteHome, '.cursor', 'chats')
  if (!args.context.provider.scanCursorSidecars) {
    recordCapabilityIssue(args, chatsRoot)
    return { candidates: [], scan: null }
  }

  let scan: CursorSidecarScanResponse
  try {
    const request = defaultCursorSidecarScanRequest(
      chatsRoot,
      args.scopePaths,
      args.context.hostPlatform.os
    )
    scan = cursorSidecarScanResponseSchema.parse(
      await args.context.provider.scanCursorSidecars(request, { signal: args.signal })
    )
  } catch (error) {
    if ((error as Error).message === 'remote_cursor_sidecar_scan_unavailable') {
      recordCapabilityIssue(args, chatsRoot)
    } else {
      args.issues.push({
        executionHostId: args.context.executionHostId,
        agent: 'cursor',
        path: chatsRoot,
        message: `Cursor sidecar scan failed: ${errorMessage(error)}`
      })
    }
    return { candidates: [], scan: null }
  }

  for (const issue of scan.issues) {
    args.issues.push({
      executionHostId: args.context.executionHostId,
      agent: 'cursor',
      path: issue.path,
      message: issue.message
    })
  }
  const source = remoteCursorSidecarSource(chatsRoot, args.context.executionHostId)
  return {
    candidates: scan.sidecars.map((sidecar) => {
      const file: FileWithMtime = {
        path: sidecar.metaPath,
        mtimeMs: sidecar.metaMtimeMs,
        modifiedAt: safeDateIso(sidecar.metaMtimeMs),
        sizeBytes: sidecar.metaSizeBytes,
        cursorStoreMtimeMs: sidecar.storeMtimeMs
      }
      const scopeCwd = validatedRemoteScopeCwd(sidecar, args.context, args.issues)
      return {
        source,
        file,
        cursorSidecarContent: sidecar.content,
        ...(scopeCwd
          ? {
              cursorCwdEvidence: {
                kind: 'scope-bucket' as const,
                cwd: scopeCwd,
                bucket: sidecar.bucket
              }
            }
          : {})
      }
    }),
    scan
  }
}

function validatedRemoteScopeCwd(
  sidecar: CursorSidecarScanResponse['sidecars'][number],
  context: RemoteScannerContext,
  issues: AiVaultScanIssue[]
): string | null {
  if (!sidecar.scopeCwd) {
    return null
  }
  if (
    isAbsoluteCursorTargetPath(sidecar.scopeCwd, context.hostPlatform.os) &&
    cursorBucketForCwd(sidecar.scopeCwd, context.hostPlatform.os) === sidecar.bucket
  ) {
    return sidecar.scopeCwd
  }
  issues.push({
    executionHostId: context.executionHostId,
    agent: 'cursor',
    path: sidecar.metaPath,
    message: 'Cursor scope metadata does not match its storage bucket.'
  })
  return null
}

export function attachRemoteCursorLegacyScopeEvidence(
  candidates: readonly RemoteSessionCandidate[],
  scan: CursorSidecarScanResponse | null,
  context: RemoteScannerContext
): RemoteSessionCandidate[] {
  if (!scan || scan.scopeCwds.length === 0) {
    return [...candidates]
  }
  const bySlug = new Map<string, Set<string>>()
  for (const cwd of scan.scopeCwds) {
    const slug = cursorLegacySlug(cwd)
    if (!slug) {
      continue
    }
    const buckets = bySlug.get(slug) ?? new Set<string>()
    buckets.add(cursorBucketForCwd(cwd, context.hostPlatform.os))
    bySlug.set(slug, buckets)
  }
  return candidates.map((candidate) => {
    if (candidate.source.agent !== 'cursor' || candidate.source.cursorLayout !== 'legacy') {
      return candidate
    }
    const slug = remoteLegacyProjectSlug(candidate)
    const buckets = slug ? bySlug.get(slug) : undefined
    if (!buckets || buckets.size !== 1) {
      return candidate
    }
    return {
      ...candidate,
      cursorCwdEvidence: {
        kind: 'legacy-scope-only',
        cwd: null,
        bucket: buckets.values().next().value as string
      }
    }
  })
}

function remoteLegacyProjectSlug(candidate: RemoteSessionCandidate): string | null {
  const root = candidate.source.rootDir.replace(/\\/gu, '/').replace(/\/+$/u, '')
  const filePath = candidate.file.path.replace(/\\/gu, '/')
  return filePath.startsWith(`${root}/`)
    ? filePath.slice(root.length + 1).split('/')[0] || null
    : null
}

function remoteCursorSidecarSource(
  rootDir: string,
  storageContextKey: string
): RemoteSessionSource {
  return {
    agent: 'cursor',
    rootDir,
    extensions: ['.json'],
    cursorLayout: 'sidecar',
    cursorStorageContextKey: storageContextKey,
    parse: async () => null
  }
}

function recordCapabilityIssue(
  args: Pick<Parameters<typeof discoverRemoteCursorSidecars>[0], 'context' | 'issues'>,
  chatsRoot: string
): void {
  args.issues.push({
    executionHostId: args.context.executionHostId,
    agent: 'cursor',
    path: chatsRoot,
    message:
      'Cursor session metadata scanning is unavailable on this SSH relay. Reconnect after updating Orca.'
  })
}

function safeDateIso(value: number): string {
  return Math.abs(value) <= 8_640_000_000_000_000
    ? new Date(value).toISOString()
    : new Date(0).toISOString()
}
