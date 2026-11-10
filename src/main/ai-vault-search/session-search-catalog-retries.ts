import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import { SESSION_INPUT_FAILURES_BEFORE_HELD_OUT } from '../ai-vault/session-observation-retries'
import { isInsideSessionRoot } from '../ai-vault/session-file-discovery'
import { recordSessionScanIssue, SCAN_ISSUE_LIMIT } from '../ai-vault/session-scan-issues'
import type { SessionSearchCatalogClient } from './session-search-catalog-client'

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
    return this.catalog.readySize > 0
  }
  async begin(wake = false): Promise<void> {
    this.generation++
    if (wake) {
      await this.wake()
    }
  }
  async force(path: string): Promise<boolean> {
    return (await this.catalog.get(path))?.force ?? false
  }
  async requireRead(path: string): Promise<void> {
    const debt = await this.catalog.get(path)
    if (debt && !debt.force) {
      await this.put(path, { ...debt, force: true })
    }
  }
  async heldOut(path: string): Promise<boolean> {
    return this.held(await this.catalog.get(path))
  }
  async mayAttempt(path: string): Promise<boolean> {
    const debt = await this.catalog.get(path)
    return !debt || (!this.held(debt) && debt.attempted !== this.generation)
  }
  async fail(path: string, force = false, issue?: AiVaultScanIssue): Promise<void> {
    const previous = await this.catalog.get(path)
    const debt = {
      failures: (previous?.failures ?? 0) + 1,
      attempted: this.generation,
      force: force || (previous?.force ?? false),
      issue: issue ?? previous?.issue
    }
    await this.put(path, debt)
  }
  async wake(path?: string): Promise<void> {
    let after: string | undefined
    do {
      const page = await this.catalog.page({ after, prefix: path })
      for (const { key, value } of page.rows) {
        if (path === undefined || isInsideSessionRoot(path, key)) {
          await this.put(key, { ...value, failures: 0 })
        }
      }
      after = page.after
    } while (after !== undefined)
  }
  async delete(path: string): Promise<void> {
    const debt = await this.catalog.get(path)
    if (!debt) {
      return
    }
    await this.catalog.delete(path)
  }
  async *runnable(): AsyncGenerator<readonly [string, boolean]> {
    let after: string | undefined
    do {
      const page = await this.catalog.page({ after, ready: 1 })
      for (const { key, value } of page.rows) {
        if (value.attempted !== this.generation) {
          yield [key, value.force]
        }
      }
      after = page.after
    } while (after !== undefined)
  }
  async report(issues: AiVaultScanIssue[]): Promise<void> {
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
  private put(path: string, debt: Debt): Promise<void> {
    return this.catalog.put(path, debt, {
      group: debt.issue ? 'issue' : '',
      ready: Number(!this.held(debt))
    })
  }
}
