// The no-tools audit adapter: a single bounded turn, then a verdict.
//
// MEDIATED RETRIEVAL IS DISABLED FOR THE FIRST RELEASE
// (MEDIATED_RETRIEVAL_ENABLED = false, maxFollowUpTurns = 0). The adapter
// operates ONLY on the bundle the orchestration already prepared. The scope
// validation and request parsing remain present and tested so enabling the
// capability is a reviewed one-line change rather than a rewrite — but no
// follow-up turn can be dispatched in the shipped configuration, and
// audited-no-tools-adapter.test.ts pins exactly that.
//
// RETURNS A CodexProcessOutcome. That is deliberate and is what keeps this
// change small: decideCodeAuditOutcome and decidePlanReviewOutcome already
// switch exhaustively over that union and already fail closed on every non-exit
// arm, so expressing transport failures in the SAME vocabulary means no decision
// logic has to learn a second failure shape. A new arm added to the union breaks
// those switches at compile time via lint:switch-exhaustiveness, which is
// exactly the review pressure we want on a path that can produce an approval.
//
// NO SUBPROCESS IS CREATED ANYWHERE IN THIS FILE OR ITS IMPORTS. The
// boundary test asserts that structurally.
import { readFileSync } from 'node:fs'
import {
  MEDIATED_RETRIEVAL_ENABLED,
  NO_TOOLS_LIMITS,
  type NoToolsReasonCode
} from '../../shared/audited-audit-mode-types'
import type { CodexProcessOutcome } from './audited-codex-process'
import {
  appendRetrievedFiles,
  buildAuditBundle,
  renderBundle,
  type BundleFile,
  type BundleInput,
  type BundleSection
} from './audited-no-tools-bundle'
import { buildNoToolsSystemPrompt, parseContextRequest } from './audited-no-tools-prompt'
import { resolveRequestedPath, validateContextRequest } from './audited-no-tools-scope'
import { dispatchNoToolsTurn, type NoToolsMessage } from './audited-no-tools-transport'

export type NoToolsAuditArgs = {
  bundle: BundleInput
  /**
   * The root mediated retrieval may read from — the audited worktree, supplied
   * by the orchestration from durable state. Never renderer-supplied, and never
   * widened to the source repository.
   */
  scopeRoot: string
}

/**
 * Runs an audit and returns a CLI-shaped outcome.
 *
 * NEVER REJECTS. Every failure is a closed arm, because a rejection would leave
 * the caller's `running` row unfinalized — the same contract runCodexProcess
 * holds.
 */
export async function runNoToolsAudit(args: NoToolsAuditArgs): Promise<CodexProcessOutcome> {
  const built = buildAuditBundle(args.bundle)
  if (!built.ok) {
    // NOTHING WAS SENT. The bundle failed its own caps or could not be redacted,
    // so the audit ends before any byte left the machine.
    return noToolsFailure(built.reasonCode)
  }

  let sections: readonly BundleSection[] = built.sections
  const messages: NoToolsMessage[] = [
    { role: 'system', content: buildNoToolsSystemPrompt() },
    { role: 'user', content: renderBundle(sections) }
  ]

  // ONE deadline for the whole audit, follow-up turns included. A per-turn
  // timeout would let N turns take N times as long as the declared bound.
  const deadline = Date.now() + NO_TOOLS_LIMITS.requestTimeoutMs

  for (let turn = 0; turn <= NO_TOOLS_LIMITS.maxFollowUpTurns; turn += 1) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return noToolsFailure('api_timeout')
    }

    const response = await dispatchNoToolsTurn({ messages, timeoutMs: remainingMs })
    if (!response.ok) {
      return noToolsFailure(response.reasonCode)
    }

    const request = parseContextRequest(response.text)
    if (request === null) {
      // Not a retrieval request, so this is the model's final answer. The text
      // goes to the SHARED verdict parser, which fails closed independently —
      // this adapter never decides that something is an approval.
      return { kind: 'exit', exitCode: 0, stdout: '', stderr: '', lastMessage: response.text }
    }

    // RETRIEVAL IS DISABLED FOR THE FIRST RELEASE. The prompt does not offer the
    // affordance, so a `needFiles` reply here means the model invented it — a
    // protocol violation that ends the audit rather than being served.
    //
    // Checked INDEPENDENTLY of the turn budget below: either guard alone stops
    // a follow-up dispatch, so flipping one without the other cannot open the
    // path by accident.
    if (!MEDIATED_RETRIEVAL_ENABLED) {
      console.warn('[auditedWorkflow] Refused a context request: retrieval is disabled.')
      return noToolsFailure('context_request_invalid')
    }

    // A request arriving on the LAST permitted turn cannot be served, and
    // answering it would need a turn that does not exist. With
    // maxFollowUpTurns at 0 this is every request, so the loop below is
    // unreachable in the shipped configuration.
    if (turn === NO_TOOLS_LIMITS.maxFollowUpTurns) {
      return noToolsFailure('context_budget_exhausted')
    }

    const retrieved = retrieveRequestedFiles(args.scopeRoot, request.needFiles)
    if (!retrieved.ok) {
      // ANY invalid request ends the audit. See audited-no-tools-scope.ts: a
      // skipped-and-continue policy would let a model probe for what exists.
      return noToolsFailure(retrieved.reasonCode)
    }

    const appended = appendRetrievedFiles(sections, retrieved.files, args.bundle.redactionContext)
    if (!appended.ok) {
      return noToolsFailure(appended.reasonCode)
    }
    sections = appended.sections

    messages.push({ role: 'assistant', content: response.text })
    messages.push({
      role: 'user',
      content: `${renderBundle(sections)}\n\nThe requested files are included above. Now give your final verdict JSON.`
    })
  }

  // Unreachable: the loop either returns a verdict or exhausts its budget on the
  // final turn. Kept as a closed failure rather than a throw so the caller's
  // running row is always finalized.
  return noToolsFailure('context_budget_exhausted')
}

type RetrievalResult =
  | { ok: true; files: readonly BundleFile[] }
  | { ok: false; reasonCode: NoToolsReasonCode }

/**
 * Validates and reads every requested path, or fails the whole request.
 *
 * ALL-OR-NOTHING by construction: paths are validated first and read only after
 * every one has passed, so a partially-served request cannot exist.
 */
function retrieveRequestedFiles(scopeRoot: string, requested: readonly string[]): RetrievalResult {
  const shape = validateContextRequest(requested)
  if (!shape.ok) {
    return { ok: false, reasonCode: 'context_request_invalid' }
  }

  const resolved: { absolutePath: string; relativePath: string }[] = []
  let totalBytes = 0

  for (const path of shape.paths) {
    const resolution = resolveRequestedPath(scopeRoot, path)
    if (!resolution.ok) {
      // The REJECTION CODE IS NOT REPORTED to the model or the user. Telling a
      // caller which of "outside scope" / "not a file" a path hit is a
      // filesystem oracle: repeated audits would map the disk one refusal at a
      // time. One opaque code covers every rejection.
      console.warn('[auditedWorkflow] Refused an out-of-scope audit context request.')
      return { ok: false, reasonCode: 'context_request_invalid' }
    }
    totalBytes += resolution.byteSize
    if (totalBytes > NO_TOOLS_LIMITS.maxBundleBytes) {
      return { ok: false, reasonCode: 'context_budget_exhausted' }
    }
    resolved.push(resolution)
  }

  const files: BundleFile[] = []
  for (const entry of resolved) {
    try {
      files.push({
        relativePath: entry.relativePath,
        contents: readFileSync(entry.absolutePath, 'utf8')
      })
    } catch {
      // A file that vanished or turned unreadable between validation and read.
      // Refusing is the only safe response: continuing would send a partial set
      // while the model believes it received everything it asked for.
      return { ok: false, reasonCode: 'context_request_invalid' }
    }
  }

  return { ok: true, files }
}

function noToolsFailure(reasonCode: NoToolsReasonCode): CodexProcessOutcome {
  return { kind: 'no_tools_failed', reasonCode }
}
