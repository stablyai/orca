import { withTimeout } from '../../shared/promise-timeout-fallback'
import { dedupeInFlightRun } from '../in-flight-run-dedupe'
import { resolveCodexCommand } from '../codex-cli/command'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'
import {
  deriveCodexHookHashes,
  fingerprintCodex,
  probeCodexVersion,
  sweepStaleCodexScratchHomes,
  type CodexHookAnswer,
  type CodexHookHashes
} from './codex-hook-trust-derivation'
import {
  codexBinaryKey,
  memoizeCodexHookAnswer,
  readEveryMemoizedCodexHookHashes,
  readMemoizedCodexHookAnswer,
  readMemoizedVersionAnswer
} from './codex-hook-trust-memo'

// Cold hash derivation must not delay launches beyond this bound.
export const CODEX_HOOK_LAUNCH_WAIT_MS = 3_000
// Retry boot-time failures without requiring an app restart.
const PENDING_RETRY_MS = 60_000

type KnownAnswer = {
  fingerprint: string
  command: string
  answer: CodexHookAnswer
  retryAt?: number
}

// Re-probe persisted binary versions once per process before trusting their answers.
const answers = new Map<string, KnownAnswer>()
const derivations = new Map<string, Promise<CodexHookAnswer>>()
// Only app main may spawn Codex after PATH hydration; other callers read the memo.
let appPathReady: Promise<unknown> | null = null

/** App main only; pathReady must settle without rejecting. */
export function startCodexHookHashLookup(pathReady: Promise<unknown>): void {
  appPathReady = pathReady
  void sweepStaleCodexScratchHomes()
}

/** Reuse known answers or query Codex in app main, deduplicated per binary. */
export function lookupCodexHookAnswer(
  codexPath: string,
  command: string
): Promise<CodexHookAnswer> {
  const fingerprint = fingerprintCodex(codexPath)
  if (fingerprint === null) {
    // Do not cache absence: PATH hydration or an install may make the binary available.
    return Promise.resolve(codexNotFound(codexPath))
  }
  const known = answers.get(codexBinaryKey(codexPath))
  if (
    known?.fingerprint === fingerprint &&
    known.command === command &&
    (known.retryAt ?? Infinity) > Date.now()
  ) {
    return Promise.resolve(known.answer)
  }
  if (!appPathReady) {
    return Promise.resolve(
      readMemoizedCodexHookAnswer(codexPath, command, fingerprint) ?? {
        kind: 'pending',
        failure: 'Orca has not asked Codex yet'
      }
    )
  }
  return dedupeInFlightRun(derivations, fingerprint, () =>
    askCodexForHookHashes(codexPath, command, fingerprint)
  )
}

async function askCodexForHookHashes(
  codexPath: string,
  command: string,
  fingerprint: string
): Promise<CodexHookAnswer> {
  let answer: CodexHookAnswer
  try {
    // Shim bytes can stay unchanged when the underlying Codex updates.
    const codexVersion = await probeCodexVersion(codexPath)
    answer = codexVersion
      ? (readMemoizedVersionAnswer(codexVersion, command) ??
        (await deriveCodexHookHashes(codexPath, command, codexVersion)))
      : { kind: 'pending', failure: `${codexPath} did not report its version` }
  } catch (error) {
    answer = { kind: 'pending', failure: error instanceof Error ? error.message : String(error) }
  }
  if (answer.kind === 'pending') {
    // Throttle repeated failures while allowing boot-time PATH issues to recover.
    return remember(codexPath, {
      fingerprint,
      command,
      answer,
      retryAt: Date.now() + PENDING_RETRY_MS
    })
  }
  memoizeCodexHookAnswer(codexPath, fingerprint, command, answer)
  return remember(codexPath, { fingerprint, command, answer })
}

function remember(codexPath: string, known: KnownAnswer): CodexHookAnswer {
  answers.set(codexBinaryKey(codexPath), known)
  return known.answer
}

/** Query the Codex on PATH only in app main. */
export async function resolveCodexHookAnswer(): Promise<CodexHookAnswer> {
  // Resolve the same hydrated PATH that panes use.
  await appPathReady
  return lookupCodexHookAnswer(resolveCodexCommand(), getManagedCommand(getManagedScriptPath()))
}

/** Read status from memory or disk without spawning Codex. */
export function readKnownCodexHookAnswer(): CodexHookAnswer | null {
  const codexPath = resolveCodexCommand()
  const fingerprint = fingerprintCodex(codexPath)
  if (fingerprint === null) {
    return codexNotFound(codexPath)
  }
  const command = getManagedCommand(getManagedScriptPath())
  const known = answers.get(codexBinaryKey(codexPath))
  const current =
    known?.fingerprint === fingerprint && known.command === command ? known.answer : null
  if (current?.kind === 'hashes') {
    return current
  }
  return (
    readMemoizedCodexHookAnswer(codexPath, command, fingerprint) ??
    (derivations.has(fingerprint) ? CODEX_ANSWER_AWAITED : current)
  )
}

export const CODEX_ANSWER_AWAITED: CodexHookAnswer = {
  kind: 'pending',
  failure: 'waiting for Codex to answer'
}

function codexNotFound(codexPath: string): CodexHookAnswer {
  return {
    kind: 'pending',
    failure: `Orca could not find Codex at ${codexPath}`,
    codexMissing: true
  }
}

/** Return null when the answer exceeds the launch wait budget. */
export function resolveCodexHookAnswerForLaunch(waitMs: number): Promise<CodexHookAnswer | null> {
  return withTimeout<CodexHookAnswer | null>(resolveCodexHookAnswer(), waitMs, null)
}

/** Include all remembered versions to recognize Orca's earlier approvals. */
export function readEveryKnownCodexHookHashes(): CodexHookHashes[] {
  return [
    ...[...answers.values()].flatMap(({ answer }) =>
      answer.kind === 'hashes' ? [answer.hashes] : []
    ),
    ...readEveryMemoizedCodexHookHashes()
  ]
}

export const _internals = {
  resetForTesting(): void {
    answers.clear()
    derivations.clear()
    appPathReady = null
  }
}
