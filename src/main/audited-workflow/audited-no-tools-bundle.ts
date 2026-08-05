// Assembles the bounded, redacted audit bundle sent to the no-tools adapter.
//
// THE ADAPTER READS NOTHING ITSELF. Every byte here comes from an ALREADY
// PREPARED artifact set that the orchestration built from durable state — the
// same worktree-derived material the CLI path uses. This module resolves no
// path of its own, which is what keeps the design honest across local, WSL,
// SSH, and folder workspaces: the caller owns host-specific retrieval, and the
// adapter owns only bounding and redaction.
//
// EVERY FRAGMENT IS REDACTED BEFORE IT IS COUNTED, and counted before it is
// included. Doing it in the other order would let an over-cap file be redacted
// and then dropped — wasted work — or worse, let a fragment be measured in its
// redacted form and included in its raw one.
import { NO_TOOLS_LIMITS, type NoToolsReasonCode } from '../../shared/audited-audit-mode-types'
import type { AuditedAcceptanceCriterion } from '../../shared/audited-workflow-types'
import { sanitizePlanText, type PlanSanitizationContext } from './audited-plan-artifact-store'

/** One file's contribution, already read by the caller. */
export type BundleFile = {
  /** Worktree-relative, POSIX-separated. Never absolute. */
  relativePath: string
  contents: string
}

export type BundleInput = {
  title: string
  description: string
  acceptanceCriteria: readonly AuditedAcceptanceCriterion[]
  /** Sanitized plan text for the plan lane; null for the code lane. */
  planText: string | null
  /** `git diff --stat`-shaped summary. Caller-produced. */
  diffStat: string
  /** The unified diff, already bounded by the caller's read. */
  diff: string
  files: readonly BundleFile[]
  /** Redaction context — the trusted identity values to scrub. */
  redactionContext: PlanSanitizationContext
}

export type BundleSection = { heading: string; body: string }

export type BundleResult =
  | { ok: true; sections: readonly BundleSection[]; totalBytes: number; redactionCount: number }
  | { ok: false; reasonCode: NoToolsReasonCode }

/**
 * Builds the bundle, or fails closed.
 *
 * Returns `bundle_too_large` rather than truncating the file set. Truncation
 * would silently narrow what the audit saw while still producing a verdict that
 * claims to cover the work — an audit that judged 12 of 40 files but reported no
 * caveat is worse than one that refused.
 *
 * The DIFF is the exception and is truncated with an explicit marker, because a
 * diff is inherently unbounded and the marker keeps the narrowing visible to the
 * model and to the stored evidence.
 */
export function buildAuditBundle(input: BundleInput): BundleResult {
  if (input.files.length > NO_TOOLS_LIMITS.maxBundleFiles) {
    return { ok: false, reasonCode: 'bundle_too_large' }
  }

  let redactionCount = 0
  const redact = (raw: string): string => {
    const result = sanitizePlanText(raw, input.redactionContext)
    redactionCount += result.redactionCount
    return result.text
  }

  const sections: BundleSection[] = []

  try {
    sections.push({ heading: 'Task', body: redact(input.title) })
    sections.push({
      heading: 'Description',
      body: input.description.trim().length > 0 ? redact(input.description) : '(none provided)'
    })
    sections.push({
      heading: 'Acceptance criteria',
      body: input.acceptanceCriteria.length
        ? input.acceptanceCriteria.map((c) => `- [${c.id}] ${redact(c.text)}`).join('\n')
        : '(none recorded)'
    })

    if (input.planText !== null) {
      sections.push({ heading: 'Proposed plan', body: redact(input.planText) })
    }

    sections.push({ heading: 'Change summary', body: redact(input.diffStat) })

    const redactedDiff = redact(input.diff)
    sections.push({
      heading: 'Diff',
      body:
        redactedDiff.length <= NO_TOOLS_LIMITS.maxDiffBytes
          ? redactedDiff
          : `${redactedDiff.slice(0, NO_TOOLS_LIMITS.maxDiffBytes)}\n[diff truncated by Orca]`
    })

    for (const file of input.files) {
      if (Buffer.byteLength(file.contents, 'utf8') > NO_TOOLS_LIMITS.maxFileBytes) {
        return { ok: false, reasonCode: 'bundle_too_large' }
      }
      sections.push({
        // The path is redacted too: a worktree-relative path can still embed a
        // branch name or a user directory in a fixture tree.
        heading: `File: ${redact(file.relativePath)}`,
        body: redact(file.contents)
      })
    }
  } catch (error) {
    // sanitizePlanText is pure and should not throw, but an un-redactable
    // fragment must never fall through to being SENT RAW. Failing closed here is
    // the difference between a refused audit and a leak.
    console.error('[auditedWorkflow] Redacting the audit bundle failed.', errorKind(error))
    return { ok: false, reasonCode: 'redaction_failed' }
  }

  const totalBytes = measure(sections)
  if (totalBytes > NO_TOOLS_LIMITS.maxBundleBytes) {
    return { ok: false, reasonCode: 'bundle_too_large' }
  }

  return { ok: true, sections, totalBytes, redactionCount }
}

/**
 * Appends mediated-retrieval results to an existing bundle under the same caps.
 *
 * The follow-up budget is enforced against the ORIGINAL total, so a model cannot
 * grow the payload past the cap one turn at a time.
 */
export function appendRetrievedFiles(
  sections: readonly BundleSection[],
  files: readonly BundleFile[],
  redactionContext: PlanSanitizationContext
): BundleResult {
  let redactionCount = 0
  const appended: BundleSection[] = [...sections]

  try {
    for (const file of files) {
      const path = sanitizePlanText(file.relativePath, redactionContext)
      const body = sanitizePlanText(file.contents, redactionContext)
      redactionCount += path.redactionCount + body.redactionCount
      appended.push({ heading: `File: ${path.text}`, body: body.text })
    }
  } catch (error) {
    console.error('[auditedWorkflow] Redacting retrieved files failed.', errorKind(error))
    return { ok: false, reasonCode: 'redaction_failed' }
  }

  const totalBytes = measure(appended)
  if (totalBytes > NO_TOOLS_LIMITS.maxBundleBytes) {
    return { ok: false, reasonCode: 'context_budget_exhausted' }
  }

  return { ok: true, sections: appended, totalBytes, redactionCount }
}

/** Renders the bundle as the user-turn text. */
export function renderBundle(sections: readonly BundleSection[]): string {
  return sections.map((section) => `## ${section.heading}\n${section.body}`).join('\n\n')
}

function measure(sections: readonly BundleSection[]): number {
  return sections.reduce(
    (total, section) => total + Buffer.byteLength(`${section.heading}\n${section.body}`, 'utf8'),
    0
  )
}

/**
 * A CLASS NAME ONLY — never the message.
 *
 * A redaction failure's error message can quote the very fragment that failed to
 * redact, so logging it would defeat the redaction it is reporting.
 */
function errorKind(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error
}
