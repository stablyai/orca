import { afterEach, expect, it, vi } from 'vitest'
import { acquired, fakeClaude, PROVIDER_SESSION_ID } from './claude-structured-session-test-support'
import { agentSessionRecordFixture } from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'

afterEach(() => vi.restoreAllMocks())

it('retains retirement knowledge when the optional title method is missing', async () => {
  const cli = fakeClaude()
  const adapter = await acquired(cli)
  try {
    const record = agentSessionRecordFixture()
    record.sessionId = 'session-1'
    record.providerHandleChain[0]!.handle.nativeId = PROVIDER_SESSION_ID
    const owner = adapter.captureConversationTitleOwner(record)!
    expect(owner.isCurrent(record)).toBe(true)
    expect(await owner.generate('Repair login', () => owner.isCurrent(record))).toBeNull()
    await adapter.closeAll()
    expect(owner.isCurrent(record)).toBe(false)
  } finally {
    await adapter.closeAll()
    cli.dispose()
  }
})
