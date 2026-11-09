// Shared per-run context for checks: the run file, the sandbox ledger, identities and a lazily
// created primary workspace (with the test repo) that most single-VM checks reuse to save cost.
import { Sandboxes, type ReadyView } from './clients'
import { config } from './env'
import type { CheckResult, Evidence, RunState, Status } from './run-state'
import type { Identity } from './tokens'

export type Outcome = { status: Status; detail: string; evidence?: Evidence[]; timingsMs?: Record<string, number> }
export type Check = (ctx: Ctx) => Promise<Outcome>

export class Ctx {
  readonly sandboxes: Sandboxes
  /** Solo account (dev:w9-eval) and a team org with an owner and a member (dev:org:w9-eval-team). */
  readonly solo: Identity = { sub: 'w9-eval' }
  readonly owner: Identity = { sub: 'w9-owner', org: 'w9-eval-team', orgRole: 'owner' }
  readonly member: Identity = { sub: 'w9-member', org: 'w9-eval-team', orgRole: 'member' }
  readonly outsider: Identity = { sub: 'w9-outsider' }
  private primaryReady: Promise<ReadyView & { createMs: number }> | null = null

  constructor(readonly run: RunState) {
    this.sandboxes = new Sandboxes(run)
  }

  /** One workspace with the private test repo, shared by the single-VM checks of this run. */
  primary(): Promise<ReadyView & { createMs: number }> {
    this.primaryReady ??= (async () => {
      const reply = await this.sandboxes.create(this.solo, {
        workspaceId: `w9-primary-${this.run.file.runId}`,
        repo: { url: config.testRepo }
      })
      if (reply.status !== 200) {
        throw new Error(`primary create failed: ${reply.status} ${JSON.stringify(reply.body)}`)
      }
      return { ...reply.body, createMs: reply.ms }
    })()
    return this.primaryReady
  }

  /** Re-point the cached primary after a resume/rollover hands back a new session. */
  updatePrimary(view: ReadyView): void {
    const prev = this.primaryReady
    this.primaryReady = (async () => ({ ...view, createMs: (await prev)?.createMs ?? 0 }))()
  }

  exec(sessionId: string, script: string, timeoutMs?: number) {
    return this.sandboxes.exec(sessionId, script, timeoutMs)
  }
}

export async function runCheck(ctx: Ctx, id: string, check: Check): Promise<CheckResult> {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  let outcome: Outcome
  try {
    outcome = await check(ctx)
  } catch (error) {
    outcome = { status: 'fail', detail: `threw: ${String(error instanceof Error ? error.message : error).slice(0, 600)}` }
  }
  const result: CheckResult = {
    id,
    status: outcome.status,
    detail: outcome.detail,
    evidence: outcome.evidence ?? [],
    ...(outcome.timingsMs ? { timingsMs: outcome.timingsMs } : {}),
    startedAt,
    durationMs: Math.round(performance.now() - started)
  }
  ctx.run.record(result)
  const mark = { pass: 'PASS', fail: 'FAIL', partial: 'PART', not_landed: 'TODO', skipped: 'SKIP' }[result.status]
  console.log(`${mark} ${id} (${result.durationMs}ms) ${result.detail.slice(0, 200)}`)
  return result
}

export const log = (label: string, text: string): Evidence => ({ kind: 'log', label, text: text.slice(0, 4000) })
export const timing = (label: string, ms: number): Evidence => ({ kind: 'timing', label, text: `${ms} ms` })
