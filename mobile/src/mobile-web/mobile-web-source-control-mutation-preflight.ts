import {
  MobileWebSourceControlMutationEntrySchema,
  type MobileWebSourceControlMutationEntry
} from '../../../src/shared/mobile-web/source-control-mutation-contract'
import { MobileWebBrokerError } from './mobile-web-broker-error'

const MOBILE_WEB_SOURCE_CONTROL_PREFLIGHT_SCAN_LIMIT = 10_000

export function assertMobileWebSourceControlMutationPreflight(args: {
  result: unknown
  expectedHead: string | null
  entries: readonly MobileWebSourceControlMutationEntry[]
}): void {
  if (!isRecord(args.result) || !Array.isArray(args.result.entries)) {
    throw new MobileWebBrokerError('host_error')
  }
  if (readHead(args.result.head) !== args.expectedHead) {
    throw new MobileWebBrokerError('conflict')
  }

  const expected = new Map(args.entries.map((entry) => [mutationEntryKey(entry), entry] as const))
  const matched = new Set<string>()
  const scanLength = Math.min(
    args.result.entries.length,
    MOBILE_WEB_SOURCE_CONTROL_PREFLIGHT_SCAN_LIMIT
  )
  for (let index = 0; index < scanLength; index += 1) {
    const candidate = sanitizeMutationEntry(args.result.entries[index])
    if (!candidate) {
      continue
    }
    const key = mutationEntryKey(candidate)
    const expectedEntry = expected.get(key)
    if (!expectedEntry) {
      continue
    }
    if (!sameMutationEntry(candidate, expectedEntry) || matched.has(key)) {
      throw new MobileWebBrokerError('conflict')
    }
    matched.add(key)
  }
  if (matched.size !== expected.size) {
    throw new MobileWebBrokerError('conflict')
  }
}

function sanitizeMutationEntry(candidate: unknown): MobileWebSourceControlMutationEntry | null {
  if (!isRecord(candidate)) {
    return null
  }
  const parsed = MobileWebSourceControlMutationEntrySchema.safeParse({
    relativePath: candidate.path,
    ...(candidate.oldPath === undefined ? {} : { oldRelativePath: candidate.oldPath }),
    status: candidate.status,
    area: candidate.area,
    ...(candidate.conflictStatus === undefined ? {} : { conflictStatus: candidate.conflictStatus })
  })
  return parsed.success ? parsed.data : null
}

function sameMutationEntry(
  current: MobileWebSourceControlMutationEntry,
  expected: MobileWebSourceControlMutationEntry
): boolean {
  return (
    current.relativePath === expected.relativePath &&
    current.oldRelativePath === expected.oldRelativePath &&
    current.status === expected.status &&
    current.area === expected.area &&
    current.conflictStatus === expected.conflictStatus
  )
}

function mutationEntryKey(entry: MobileWebSourceControlMutationEntry): string {
  return `${entry.area}\0${entry.relativePath}`
}

function readHead(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
