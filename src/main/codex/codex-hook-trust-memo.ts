import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { isPlainObject } from '../agent-hooks/hooks-json-read'
import { getOrcaUserDataPath } from './codex-home-paths'
import type { CodexHookAnswer, CodexHookHashes } from './codex-hook-trust-derivation'
import { CODEX_MANAGED_EVENT_LABELS } from './codex-hook-definition'
import type { CodexEventLabel } from './config-toml-trust'

// Persist app-derived answers under userData so CLI status can read them without spawning Codex.
type BinaryRecord = { fingerprint: string; codexVersion: string }

type VersionRecord = { command: string } & ({ hashes: CodexHookHashes } | { failure: string })

type MemoFile = {
  binaries: Record<string, BinaryRecord>
  versions: Record<string, VersionRecord>
}

// Only definitive answers may be reused for a Codex version.
type MemoizedCodexHookAnswer = Exclude<CodexHookAnswer, { kind: 'pending' }>

// Bound records as versions and binary paths accumulate.
const MAX_RECORDS = 8

export function getCodexHookTrustMemoPath(): string {
  return join(getOrcaUserDataPath(), 'codex-hook-trust.json')
}

export function codexBinaryKey(codexPath: string): string {
  return normalizeRuntimePathForComparison(codexPath)
}

function readMemo(): MemoFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(getCodexHookTrustMemoPath(), 'utf-8'))
    if (isPlainObject(parsed)) {
      return { binaries: readBinaries(parsed.binaries), versions: readVersions(parsed.versions) }
    }
  } catch {
    // Treat read failures as cache misses; the next lookup can re-derive.
  }
  return { binaries: {}, versions: {} }
}

function readBinaries(value: unknown): Record<string, BinaryRecord> {
  return isPlainObject(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([key, record]) =>
          isPlainObject(record) &&
          typeof record.fingerprint === 'string' &&
          typeof record.codexVersion === 'string'
            ? [[key, { fingerprint: record.fingerprint, codexVersion: record.codexVersion }]]
            : []
        )
      )
    : {}
}

function readVersions(value: unknown): Record<string, VersionRecord> {
  return isPlainObject(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([key, record]): [string, VersionRecord][] => {
          if (!isPlainObject(record) || typeof record.command !== 'string') {
            return []
          }
          const hashes = readHashes(record.hashes)
          if (hashes) {
            return [[key, { command: record.command, hashes }]]
          }
          return typeof record.failure === 'string'
            ? [[key, { command: record.command, failure: record.failure }]]
            : []
        })
      )
    : {}
}

function readHashes(value: unknown): CodexHookHashes | null {
  if (!isPlainObject(value)) {
    return null
  }
  const hashes: Partial<Record<CodexEventLabel, string | null>> = {}
  for (const label of CODEX_MANAGED_EVENT_LABELS) {
    const hash = value[label]
    // Codex owns the hash format; accept any nonempty string it reports.
    if (hash === null || (typeof hash === 'string' && hash !== '')) {
      hashes[label] = hash
    }
  }
  return Object.keys(hashes).length > 0 ? hashes : null
}

// App main must re-probe versions: unchanged shim bytes can point to an updated Codex.
export function readMemoizedCodexHookAnswer(
  codexPath: string,
  command: string,
  fingerprint: string
): MemoizedCodexHookAnswer | null {
  const memo = readMemo()
  const binary = memo.binaries[codexBinaryKey(codexPath)]
  return binary?.fingerprint === fingerprint
    ? readMemoizedVersionAnswer(binary.codexVersion, command, memo)
    : null
}

export function readMemoizedVersionAnswer(
  codexVersion: string,
  command: string,
  memo: MemoFile = readMemo()
): MemoizedCodexHookAnswer | null {
  const record = memo.versions[codexVersion]
  if (record?.command !== command) {
    return null
  }
  return 'hashes' in record
    ? { kind: 'hashes', codexVersion, hashes: record.hashes }
    : { kind: 'refused', codexVersion, failure: record.failure }
}

/** Retain old versions' hashes to recognize earlier Orca approvals. */
export function readEveryMemoizedCodexHookHashes(): CodexHookHashes[] {
  return Object.values(readMemo().versions).flatMap((record) =>
    'hashes' in record ? [record.hashes] : []
  )
}

export function memoizeCodexHookAnswer(
  codexPath: string,
  fingerprint: string,
  command: string,
  answer: MemoizedCodexHookAnswer
): void {
  try {
    const memo = readMemo()
    const key = codexBinaryKey(codexPath)
    const binary = { fingerprint, codexVersion: answer.codexVersion }
    const version: VersionRecord =
      answer.kind === 'hashes'
        ? { command, hashes: answer.hashes }
        : { command, failure: answer.failure }
    if (
      isDeepStrictEqual(memo.binaries[key], binary) &&
      isDeepStrictEqual(memo.versions[answer.codexVersion], version)
    ) {
      return
    }
    const binaries = withoutKey(memo.binaries, key)
    binaries[key] = binary
    const versions = withoutKey(memo.versions, answer.codexVersion)
    versions[answer.codexVersion] = version
    writeFileAtomically(
      getCodexHookTrustMemoPath(),
      `${JSON.stringify({ binaries: newest(binaries), versions: newest(versions) }, null, 2)}\n`
    )
  } catch (error) {
    console.warn('[codex-hook-trust] could not record Codex hook hashes:', error)
  }
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record }
  delete next[key]
  return next
}

// Writes reinsert records, making insertion order suitable for eviction.
function newest<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).slice(-MAX_RECORDS))
}
