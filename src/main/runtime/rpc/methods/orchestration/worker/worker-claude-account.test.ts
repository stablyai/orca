import { describe, expect, it, vi } from 'vitest'
import type { ClaudeManagedAccountSummary } from '../../../../../../shared/managed-account-types'
import { WorkerStartParams } from './worker-start-schema'
import { createWorkerLaunchReceipt, withWorkerLaunchAccount } from './worker-launch-preferences'
import { prepareLocalWorkerStart } from './worker-start-validation'
import { decideWorkerStartMode } from '../../orchestration-worker-start-mode'
import { assertClaudeAccountWorktreeIsLocal } from './worker-claude-account-placement'

function account(id: string, email: string): ClaudeManagedAccountSummary {
  return {
    id,
    email,
    managedAuthRuntime: 'host',
    wslDistro: null,
    authMethod: 'subscription-oauth',
    organizationUuid: null,
    organizationName: null,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
}

function createRuntime() {
  return {
    validateOrchestrationAgentLauncher: vi.fn(),
    getAccountsSnapshot: vi.fn(() => ({
      claude: {
        accounts: [
          account('acct-a', 'active@example.com'),
          account('acct-b', 'pinned@example.com')
        ],
        activeAccountId: 'acct-a'
      }
    }))
  }
}

function prepare(params: Record<string, unknown>) {
  return prepareLocalWorkerStart({
    params: WorkerStartParams.parse({ task: 'task_1', from: 'term_coord', ...params }),
    createsWorktree: false,
    runtime: createRuntime() as never
  })
}

describe('worker-start --account', () => {
  it('rejects --account beside --terminal at the schema', () => {
    const parsed = WorkerStartParams.safeParse({
      task: 'task_1',
      from: 'term_coord',
      terminal: 'term_worker',
      account: 'acct-b'
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      '--account applies to a new Claude terminal and cannot combine with --terminal.'
    )
  })

  it('resolves an email to the pinned account and records it in the launch receipt', () => {
    const { claudeAccount, launch } = prepare({ agent: 'claude', account: 'PINNED@example.com' })

    expect(claudeAccount).toEqual({
      accountId: 'acct-b',
      email: 'pinned@example.com',
      isActiveOnHost: false
    })
    const expected = { id: 'acct-b', email: 'pinned@example.com', mode: 'pinned' }
    expect(launch.receipt.requested.account).toEqual(expected)
    expect(launch.receipt.effective?.account).toEqual(expected)
  })

  it('reports the active host account as an unpinned launch', () => {
    expect(
      prepare({ agent: 'claude', account: 'acct-a' }).launch.receipt.requested.account?.mode
    ).toBe('active')
  })

  it('rejects non-Claude agents and unknown accounts before any dispatch exists', () => {
    expect(() => prepare({ agent: 'codex', account: 'acct-b' })).toThrow(
      '--account applies only to --agent claude.'
    )
    expect(() => prepare({ agent: 'claude', account: 'nobody@example.com' })).toThrow(
      /orca account list/
    )
  })

  it('leaves receipts without --account exactly as before', () => {
    const receipt = createWorkerLaunchReceipt({ agent: 'claude' })
    expect(withWorkerLaunchAccount(receipt, undefined)).toBe(receipt)
    expect(prepare({ agent: 'claude' }).launch.receipt).toEqual(receipt)
    expect(prepare({ agent: 'claude' }).claudeAccount).toBeUndefined()
  })

  it('downgrades a structured default to a terminal worker', () => {
    const settings = {
      experimentalNativeChat: true,
      openAgentTabsInChatByDefault: true,
      experimentalStructuredNativeChat: true
    }
    expect(decideWorkerStartMode({ params: { agent: 'claude' }, settings }).mode).toBe('structured')
    const mode = decideWorkerStartMode({ params: { agent: 'claude', account: 'acct-b' }, settings })
    expect(mode).toMatchObject({
      mode: 'terminal',
      preferred: 'structured',
      reason: 'pinned_claude_account'
    })
    expect(mode.detail).toContain('--account')
  })

  it('refuses an SSH workspace placement', async () => {
    await expect(
      assertClaudeAccountWorktreeIsLocal(
        {
          showTerminalWorkspaceLaunchScope: vi.fn(async () => ({ connectionId: 'ssh-1' }))
        } as never,
        'wt-1'
      )
    ).rejects.toThrow(/SSH workspace/)
    await expect(
      assertClaudeAccountWorktreeIsLocal(
        { showTerminalWorkspaceLaunchScope: vi.fn(async () => ({ connectionId: null })) } as never,
        'wt-1'
      )
    ).resolves.toBeUndefined()
  })
})
