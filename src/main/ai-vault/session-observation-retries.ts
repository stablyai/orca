import type { AiVaultScanIssue } from '../../shared/ai-vault/contracts/ai-vault-types'
import { recordSessionScanIssue } from './parsing/session-scan-issues'
import { isInsideSessionRoot } from './discovery/session-file-discovery'

export const SESSION_INPUT_FAILURES_BEFORE_HELD_OUT = 3

type Debt = { failures: number; attempted: number; force: boolean; issue?: AiVaultScanIssue }

/** Refused inputs remain recoverable after the current runnable attempt settles. */
export class SessionObservationRetries {
  private readonly debts = new Map<string, Debt>()
  private generation = 0

  clear(): void {
    this.debts.clear()
  }
  begin(wake = false): void {
    this.generation++
    if (wake) {
      this.wake()
    }
  }
  get size(): number {
    return this.debts.size
  }
  force(path: string): boolean {
    return this.debts.get(path)?.force ?? false
  }
  requireRead(path: string): void {
    const debt = this.debts.get(path)
    if (debt) {
      debt.force = true
    }
  }
  get pending(): boolean {
    return [...this.debts.values()].some(
      (debt) => debt.failures < SESSION_INPUT_FAILURES_BEFORE_HELD_OUT
    )
  }
  heldOut(path: string): boolean {
    return (this.debts.get(path)?.failures ?? 0) >= SESSION_INPUT_FAILURES_BEFORE_HELD_OUT
  }
  mayAttempt(path: string): boolean {
    const debt = this.debts.get(path)
    return (
      !debt ||
      (debt.failures < SESSION_INPUT_FAILURES_BEFORE_HELD_OUT && debt.attempted !== this.generation)
    )
  }
  fail(path: string, force = false, issue?: AiVaultScanIssue): void {
    const previous = this.debts.get(path)
    this.debts.set(path, {
      failures: (previous?.failures ?? 0) + 1,
      attempted: this.generation,
      force: force || (previous?.force ?? false),
      issue: issue ?? previous?.issue
    })
  }
  wake(path?: string): void {
    for (const [key, debt] of this.debts) {
      if (path === undefined || isInsideSessionRoot(path, key)) {
        debt.failures = 0
      }
    }
  }
  delete(path: string): void {
    this.debts.delete(path)
  }
  *keys(): IterableIterator<string> {
    yield* this.debts.keys()
  }
  *runnable(): IterableIterator<readonly [string, boolean]> {
    for (const [path, debt] of this.debts) {
      if (this.mayAttempt(path)) {
        yield [path, debt.force]
      }
    }
  }
  report(issues: AiVaultScanIssue[]): void {
    for (const debt of this.debts.values()) {
      if (debt.issue && debt.failures >= SESSION_INPUT_FAILURES_BEFORE_HELD_OUT) {
        recordSessionScanIssue(issues, debt.issue)
      }
    }
  }
}
