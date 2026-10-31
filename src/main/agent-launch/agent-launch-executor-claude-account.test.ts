import { describe, expect, it } from 'vitest'
import { harness } from './agent-launch-executor.test-fixture'

describe('a launch into a project with a saved Claude account', () => {
  const PINNED_REPO = {
    id: 'repo-1',
    agentAccounts: { claude: { mode: 'account', accountId: 'acct-b' } }
  }
  const EXISTING = { kind: 'existing', worktree: 'repo-1::/repo-1' } as const

  it('downgrades a structured Claude launch to a terminal the spawn pins', async () => {
    const h = harness({ repos: [PINNED_REPO] })
    const result = await h.run({ agent: 'claude', target: EXISTING })
    expect(h.calls).toEqual(['createSupport', 'createTerminalAgent'])
    expect(result.receipt).toMatchObject({
      mode: 'terminal',
      preferred: 'structured',
      reason: 'pinned_claude_account'
    })
    expect(result.receipt.detail).toContain('saved account')
  })

  it("keeps the host's own reason when the workspace could never pin", async () => {
    const h = harness({
      repos: [PINNED_REPO],
      createSupport: { supported: false, reason: 'remote' }
    })
    const result = await h.run({ agent: 'claude', target: EXISTING })
    expect(result.receipt).toMatchObject({ reason: 'remote_execution_host' })
  })

  it('leaves Codex and an unpinned project structured', async () => {
    const codex = harness({ repos: [PINNED_REPO] })
    expect((await codex.run({ agent: 'codex', target: EXISTING })).receipt.mode).toBe('structured')
    const ask = harness({ repos: [{ id: 'repo-1', agentAccounts: { claude: { mode: 'ask' } } }] })
    expect((await ask.run({ agent: 'claude', target: EXISTING })).receipt.mode).toBe('structured')
  })
})
