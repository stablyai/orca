import { afterEach, expect, it, vi } from 'vitest'
import { acquired, fakeClaude, PROVIDER_SESSION_ID } from './claude-structured-session-test-support'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'

afterEach(() => vi.restoreAllMocks())

it('reads only cached support and rejects a retired acquisition or changed account/context', async () => {
  const cliFlag = vi.fn(async () => 'supported' as const)
  const cli = fakeClaude()
  const adapter = await acquired(cli, { cliFlag })
  try {
    const record = agentSessionRecordFixture()
    record.sessionId = 'session-1'
    record.accountHome = { variable: 'CLAUDE_CONFIG_DIR', path: '/accounts/claude' }
    record.providerHandleChain[0]!.handle.nativeId = PROVIDER_SESSION_ID
    const generate = vi.fn(async () => 'Broken chat title')
    cli.connections[0]!.generateSessionTitle = generate
    const owner = adapter.captureConversationTitleOwner(record)!
    expect(owner.isCurrent(record)).toBe(true)
    expect(await owner.generate('Repair login', () => owner.isCurrent(record))).toBe(
      'Broken chat title'
    )
    expect(cliFlag).toHaveBeenLastCalledWith(
      { option: 'generate_session_title', firstVersion: '2.1.310' },
      250,
      false
    )
    expect(
      owner.isCurrent({ ...record, accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/other' } })
    ).toBe(false)
    expect(
      owner.isCurrent({
        ...record,
        providerContextBoundary: { operationId: 'clear-1', afterFence: 7, clearedAt: 1 }
      })
    ).toBe(false)
    await adapter.closeAll()
    expect(owner.isCurrent(record)).toBe(false)
  } finally {
    await adapter.closeAll()
    cli.dispose()
  }
})

it.each(['unknown', 'unsupported'] as const)(
  'keeps %s CLIs on the existing generator path',
  async (support) => {
    const cli = fakeClaude()
    const adapter = await acquired(cli, { cliFlag: async () => support })
    try {
      const record = agentSessionRecordFixture()
      record.sessionId = 'session-1'
      record.providerHandleChain[0]!.handle.nativeId = PROVIDER_SESSION_ID
      const generate = vi.fn(async () => 'Do not use')
      cli.connections[0]!.generateSessionTitle = generate
      const owner = adapter.captureConversationTitleOwner(record)!
      expect(await owner.generate('Repair login', () => true)).toBeNull()
      expect(generate).not.toHaveBeenCalled()
    } finally {
      await adapter.closeAll()
      cli.dispose()
    }
  }
)
