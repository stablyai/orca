import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import { SESSION_INPUT_FAILURES_BEFORE_HELD_OUT } from '../ai-vault/session-observation-retries'
import { isInsideSessionRoot } from '../ai-vault/session-file-discovery'
import { recordSessionScanIssue } from '../ai-vault/session-scan-issues'
import type { SessionSearchCatalogClient } from './session-search-catalog-client'

type Debt = { failures: number; attempted: number; force: boolean; issue?: AiVaultScanIssue }

/** Refusal debt has one owner and survives pauses without becoming an archive-sized heap. */
export class SessionSearchCatalogRetries {
  private generation = 0
  private count = 0
  private runnableCount = 0
  constructor(private readonly catalog: SessionSearchCatalogClient<Debt>) {}

  get size(): number {
    return this.count
  }
  get pending(): boolean {
    return this.runnableCount > 0
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
    this.count += previous ? 0 : 1
    this.runnableCount += Number(!this.held(debt)) - Number(!!previous && !this.held(previous))
  }
  async wake(path?: string): Promise<void> {
    let after: string | undefined
    do {
      const page = await this.catalog.page({ after, prefix: path })
      for (const { key, value } of page.rows) {
        if (path === undefined || isInsideSessionRoot(path, key)) {
          await this.put(key, { ...value, failures: 0 })
          this.runnableCount += Number(this.held(value))
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
    this.count--
    this.runnableCount -= Number(!this.held(debt))
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
    do {
      const page = await this.catalog.page({ after, ready: 0 })
      for (const { value } of page.rows) {
        if (value.issue) {
          recordSessionScanIssue(issues, value.issue)
        }
      }
      after = page.after
    } while (after !== undefined)
  }
  private held(debt: Debt | undefined): boolean {
    return (debt?.failures ?? 0) >= SESSION_INPUT_FAILURES_BEFORE_HELD_OUT
  }
  private put(path: string, debt: Debt): Promise<void> {
    return this.catalog.put(path, debt, { ready: Number(!this.held(debt)) })
  }
}
