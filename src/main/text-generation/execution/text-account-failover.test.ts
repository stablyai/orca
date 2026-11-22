import { describe, expect, it } from 'vitest'
import { runWithTextAccountFailover } from './text-account-failover'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import type {
  InternalTextGenerationResult,
  LocalGenerationTarget,
  TextAccountFailover
} from '../source-control-text-generation-types'

const target: LocalGenerationTarget = { kind: 'local', cwd: '/repo', env: { ACCOUNT: 'a' } }
const refused: InternalTextGenerationResult = {
  success: false,
  error: 'Claude failed',
  failureOutput: {
    label: 'Claude',
    exitCode: 1,
    stdout: "You've hit your 5-hour limit · resets 5:09am (UTC)\n",
    stderr: ''
  }
}

function failoverTo(
  accounts: string[],
  gate?: { entered: () => void; open: Promise<void> }
): TextAccountFailover {
  return {
    initialAccountId: 'a',
    next: async (tried) => {
      gate?.entered()
      await gate?.open
      const accountId = accounts.find((id) => !tried.has(id))
      return accountId ? { accountId, env: { ACCOUNT: accountId } } : null
    }
  }
}

function run(results: Record<string, InternalTextGenerationResult>) {
  const accounts: string[] = []
  return {
    accounts,
    run: async (attempt: LocalGenerationTarget) => {
      const account = String(attempt.env?.ACCOUNT)
      accounts.push(account)
      return results[account]
    }
  }
}

describe('runWithTextAccountFailover', () => {
  it('delivers one result from the next account and tries at most two others', async () => {
    const answered = run({ a: refused, b: refused, c: { success: true, rawOutput: 'fix: x' } })
    await expect(
      runWithTextAccountFailover({
        agentId: 'claude',
        target,
        failover: failoverTo(['a', 'b', 'c', 'd']),
        operation: 'commit-message',
        run: answered.run
      })
    ).resolves.toEqual({ success: true, rawOutput: 'fix: x' })
    expect(answered.accounts).toEqual(['a', 'b', 'c'])

    const exhausted = run({ a: refused, b: refused, c: refused, d: refused })
    await expect(
      runWithTextAccountFailover({
        agentId: 'claude',
        target,
        failover: failoverTo(['b', 'c', 'd']),
        operation: 'commit-message',
        run: exhausted.run
      })
    ).resolves.toBe(refused)
    expect(exhausted.accounts).toEqual(['a', 'b', 'c'])
  })

  it('starts no other account once Stop lands between attempts', async () => {
    const entered = Promise.withResolvers<void>()
    const open = Promise.withResolvers<void>()
    const attempts = run({ a: refused, b: { success: true, rawOutput: 'late' } })
    const pending = runWithTextAccountFailover({
      agentId: 'claude',
      target,
      failover: failoverTo(['b'], { entered: entered.resolve, open: open.promise }),
      operation: 'commit-message',
      run: attempts.run
    })
    await entered.promise
    cancelLocalGeneration('commit-message', '/repo')
    await expect(pending).resolves.toMatchObject({ success: false, canceled: true })
    open.resolve()
    await open.promise
    expect(attempts.accounts).toEqual(['a'])
  })
})
