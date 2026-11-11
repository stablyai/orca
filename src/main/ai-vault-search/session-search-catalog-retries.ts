import type { SessionSearchInputReceipt } from './session-search-catalog-types'
import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import { SESSION_INPUT_FAILURES_BEFORE_HELD_OUT } from '../ai-vault/session-observation-retries'
import { recordSessionScanIssue, SCAN_ISSUE_LIMIT } from '../ai-vault/session-scan-issues'
import { SessionSearchCatalogClient } from './session-search-catalog-client'

type Debt = { failures: number; attempted: number; force: boolean; issue?: AiVaultScanIssue }

/** Refusal debt has one owner and survives pauses without becoming an archive-sized heap. */
export class SessionSearchCatalogRetries {
  private generation = 0
  constructor(private readonly catalog: SessionSearchCatalogClient<Debt>) {}

  get epoch(): number {
    return this.generation
  }
  get size(): number {
    return this.catalog.size
  }
  get pending(): boolean {
    return (
      this.catalog.readySize > 0 ||
      new SessionSearchCatalogClient(`${this.catalog.scope}:wakes`, this.catalog.send).size > 0
    )
  }
  async begin(wake = false): Promise<void> {
    this.generation++
    if (wake) {
      await this.wake()
    }
  }
  async force(path: string, physicalScope?: string): Promise<boolean> {
    return (await this.catalog.get(path, physicalScope))?.force ?? false
  }
  async requireRead(path: string): Promise<void> {
    await this.catalog.transition({ kind: 'retry-require', scope: this.catalog.scope, path })
  }
  async heldOut(path: string): Promise<boolean> {
    return this.held(await this.catalog.get(path))
  }
  async mayAttempt(path: string): Promise<boolean> {
    const debt = await this.catalog.get(path)
    return !debt || (!this.held(debt) && debt.attempted !== this.generation)
  }
  async fail(
    path: string,
    force = false,
    issue?: AiVaultScanIssue,
    attempt?: { generation: number; receipt: SessionSearchInputReceipt }
  ): Promise<void> {
    await this.catalog.transition({
      kind: 'retry-fail',
      scope: this.catalog.scope,
      path,
      force,
      issue,
      generation: attempt?.generation ?? this.generation,
      receipt: attempt?.receipt
    })
  }
  async wake(path?: string): Promise<void> {
    if (!this.catalog.size) {
      return
    }
    await this.catalog.transition({ kind: 'retry-wake', scope: this.catalog.scope, prefix: path })
  }
  async delete(path: string): Promise<void> {
    await this.catalog.transition({ kind: 'retry-remove', scope: this.catalog.scope, path })
  }
  async report(issues: AiVaultScanIssue[]): Promise<void> {
    if (!this.catalog.size) {
      return
    }
    let after: string | undefined
    while (issues.length < SCAN_ISSUE_LIMIT) {
      const page = await this.catalog.page({
        after,
        group: 'issue',
        ready: 0,
        limit: SCAN_ISSUE_LIMIT - issues.length
      })
      for (const { value } of page.rows) {
        if (value.issue) {
          recordSessionScanIssue(issues, value.issue)
        }
      }
      if (!page.after) {
        break
      }
      after = page.after
    }
  }
  private held(debt: Debt | undefined): boolean {
    return (debt?.failures ?? 0) >= SESSION_INPUT_FAILURES_BEFORE_HELD_OUT
  }
}
