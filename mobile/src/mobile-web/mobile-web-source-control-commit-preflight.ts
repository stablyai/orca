import {
  MobileWebSourceControlCommitEntrySchema,
  type MobileWebSourceControlCommitEntry
} from '../../../src/shared/mobile-web/source-control-commit-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError, mobileWebBrokerHostRpcError } from './mobile-web-broker-error'

export async function assertFreshMobileWebCommitSnapshot(
  client: RpcClient,
  snapshot: {
    workspaceId: string
    expectedHead: string
    stagedEntries: readonly MobileWebSourceControlCommitEntry[]
  },
  hostWorkspaceId: string
): Promise<void> {
  const response = await client.sendRequest('git.status', {
    worktree: `id:${hostWorkspaceId}`
  })
  if (!response.ok) {
    throw mobileWebBrokerHostRpcError(response.error)
  }
  assertMobileWebSourceControlCommitPreflight({
    result: response.result,
    expectedHead: snapshot.expectedHead,
    stagedEntries: snapshot.stagedEntries
  })
}

export function assertMobileWebSourceControlCommitPreflight(args: {
  result: unknown
  expectedHead: string
  stagedEntries: readonly MobileWebSourceControlCommitEntry[]
}): void {
  if (!isRecord(args.result) || !Array.isArray(args.result.entries)) {
    throw new MobileWebBrokerError('host_error')
  }
  if (
    args.result.didHitLimit === true ||
    readHead(args.result.head) !== args.expectedHead ||
    hasUnresolvedEntry(args.result.entries)
  ) {
    throw new MobileWebBrokerError('conflict')
  }

  const current = readCurrentStagedEntries(args.result.entries)
  if (current.length !== args.stagedEntries.length) {
    throw new MobileWebBrokerError('conflict')
  }
  const expected = new Map(
    args.stagedEntries.map((entry) => [commitEntryKey(entry), entry] as const)
  )
  if (expected.size !== args.stagedEntries.length) {
    throw new MobileWebBrokerError('conflict')
  }
  for (const entry of current) {
    const expectedEntry = expected.get(commitEntryKey(entry))
    if (!expectedEntry || !sameCommitEntry(entry, expectedEntry)) {
      throw new MobileWebBrokerError('conflict')
    }
  }
}

function readCurrentStagedEntries(entries: unknown[]): MobileWebSourceControlCommitEntry[] {
  const staged: MobileWebSourceControlCommitEntry[] = []
  const paths = new Set<string>()
  for (const candidate of entries) {
    if (!isRecord(candidate) || candidate.area !== 'staged') {
      continue
    }
    const parsed = MobileWebSourceControlCommitEntrySchema.safeParse({
      relativePath: candidate.path,
      ...(candidate.oldPath === undefined ? {} : { oldRelativePath: candidate.oldPath }),
      status: candidate.status,
      area: candidate.area,
      ...(candidate.conflictStatus === undefined
        ? {}
        : { conflictStatus: candidate.conflictStatus })
    })
    if (!parsed.success || paths.has(parsed.data.relativePath)) {
      throw new MobileWebBrokerError('conflict')
    }
    paths.add(parsed.data.relativePath)
    staged.push(parsed.data)
  }
  return staged
}

function hasUnresolvedEntry(entries: unknown[]): boolean {
  return entries.some((entry) => isRecord(entry) && entry.conflictStatus === 'unresolved')
}

function sameCommitEntry(
  current: MobileWebSourceControlCommitEntry,
  expected: MobileWebSourceControlCommitEntry
): boolean {
  return (
    current.relativePath === expected.relativePath &&
    current.oldRelativePath === expected.oldRelativePath &&
    current.status === expected.status &&
    current.area === expected.area &&
    current.conflictStatus === expected.conflictStatus
  )
}

function commitEntryKey(entry: MobileWebSourceControlCommitEntry): string {
  return entry.relativePath
}

function readHead(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
