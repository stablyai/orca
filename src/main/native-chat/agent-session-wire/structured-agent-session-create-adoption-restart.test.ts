vi.mock(
  '../../ai-vault/scanners/opencode/reader-transport/session-scanner-opencode-sqlite-worker-spawn',
  async (original) => {
    const query = await import('../transcript-opencode-sqlite-query')
    return {
      ...(await original<object>()),
      readOpenCodeTranscriptPageViaWorker: query.readOpenCodeTranscriptPage,
      readOpenCodeTranscriptSignalViaWorker: async (args: { dbPath: string; sessionId: string }) =>
        query.readOpenCodeTranscriptSignal(args.dbPath, args.sessionId)
    }
  }
)
import { expect, it, vi } from 'vitest'
import {
  createTestParams,
  CREATE_TEST_CALLER as CALLER
} from './structured-agent-session-create-test-fixture'
import { fixture } from './structured-agent-session-create-adoption-contract-test-fixture'

it('does not found a record whose account namespace its agent cannot drive', async () => {
  const params = createTestParams(undefined, {
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/wrong/account' }
  })
  expect(await fixture.rig.host.create(CALLER, params)).toMatchObject({
    ok: false,
    refusal: { code: 'structured_agent_session_unsupported' }
  })
  expect(fixture.rig.store.listRecords()).toEqual([])
  expect(fixture.rig.store.listOperationRows()).toEqual([])
})
