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

// Why bounded: a Codex launch waits only briefly, never for a cold derivation.
export const CODEX_HOOK_LAUNCH_WAIT_MS = 3_000
// Why retried soon: a timeout at a loaded boot must not cost status until a restart.
const PENDING_RETRY_MS = 60_000

type KnownAnswer = {
  /** The binary the answer is for. */
  fingerprint: string
  command: string
  answer: CodexHookAnswer
  /** When a pending answer may be asked again. */
  retryAt?: number
}

// Why in-process: a saved record from an earlier process is only trusted after this one re-probed the version.
const answers = new Map<string, KnownAnswer>()
const derivations = new Map<string, Promise<CodexHookAnswer>>()
// Why null until the app starts the lookup: only the app's main process may spawn Codex, once PATH
// is hydrated; a lookup before that, or in another process such as the CLI, reads the memo.
let appPathReady: Promise<unknown> | null = null

/**
 * App start, main process only: lets lookups ask Codex once the shell PATH is
 * hydrated, and asks right then when hooks are on, so the first managed
 * launch usually finds the answer ready.
 */
export function startCodexHookHashLookup(options: {
  pathReady: Promise<unknown>
  isEnabled: () => boolean
}): void {
  const pathReady = options.pathReady.catch(() => {})
  appPathReady = pathReady
  void sweepStaleCodexScratchHomes()
  void pathReady.then(() => (options.isEnabled() ? resolveCodexHookAnswer() : undefined))
}

/**
 * Codex's answer about Orca's entry from `codexPath`: what this process
 * already knows, else asked of Codex in the app (its version first, then a
 * throwaway `hooks/list` for a new version). Never throws; one question per binary at a time.
 */
export function lookupCodexHookAnswer(
  codexPath: string,
  command: string
): Promise<CodexHookAnswer> {
  const fingerprint = fingerprintCodex(codexPath)
  if (fingerprint === null) {
    // Why not held back: a PATH still hydrating, or an install in progress, fixes it.
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
    // Why re-probe a saved binary: a shim's bytes stay the same when the codex behind it updates.
    const codexVersion = await probeCodexVersion(codexPath)
    answer = codexVersion
      ? (readMemoizedVersionAnswer(codexVersion, command) ??
        (await deriveCodexHookHashes(codexPath, command, codexVersion)))
      : { kind: 'pending', failure: `${codexPath} did not report its version` }
  } catch (error) {
    answer = { kind: 'pending', failure: error instanceof Error ? error.message : String(error) }
  }
  if (answer.kind === 'pending') {
    // Why held back even when it fails fast: the same bytes fail the same way, and a
    // PATH hydrating at boot can fix it, so retry after the window, not on every spawn.
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

/** Codex's answer about Orca's entry from the codex on PATH; asks Codex only in the app. Never throws. */
export async function resolveCodexHookAnswer(): Promise<CodexHookAnswer> {
  // Why wait for PATH: before it is hydrated, the codex a pane runs may not be found yet.
  await appPathReady
  return lookupCodexHookAnswer(resolveCodexCommand(), getManagedCommand(getManagedScriptPath()))
}

/** For status, without asking: this process's answer for the binary on PATH when it has hashes, else what the memo holds. */
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

/** An answer asked for and not in yet. */
export const CODEX_ANSWER_AWAITED: CodexHookAnswer = {
  kind: 'pending',
  failure: 'waiting for Codex to answer'
}

function codexNotFound(codexPath: string): CodexHookAnswer {
  return { kind: 'pending', failure: `Orca could not find Codex at ${codexPath}` }
}

/** The answer for a launch, waiting at most `waitMs` for one not known yet; null when none came in time. */
export function resolveCodexHookAnswerForLaunch(waitMs: number): Promise<CodexHookAnswer | null> {
  return withTimeout<CodexHookAnswer | null>(resolveCodexHookAnswer(), waitMs, null)
}

/** Every hash set this process or the memo holds, for any version: what Orca may have approved its entry with. */
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
