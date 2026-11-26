// @orca-isolated-worker -- Owns temporary journal databases across simulated restarts.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  openTestAgentSessionRecordStore,
  closeTestAgentSessionDatabase
} from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { agentSessionRecordFixture } from '../../testing/agent-session-record-test-fixture'
import { AgentConversationCopyStartError } from '../../conversation-adoption/agent-conversation-copy-error'
import { copyStructuredAgentSessionCurrentContext } from './structured-agent-session-current-copy'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-current-copy-'))
})
afterEach(async () => {
  await closeTestAgentSessionDatabase(root)
  await rm(root, { recursive: true, force: true })
})
function request() {
  const record = agentSessionRecordFixture({ sessionId: 'source', provider: 'codex' })
  return {
    callerKey: 'desktop-client',
    envelope: {
      sessionId: 'destination',
      clientOperationId: `${Date.now()}-000000000000000000000000000000aa`
    },
    permission: 'inherit' as const,
    source: {
      current: true as const,
      record,
      providerSessionId: 'native-source',
      accountHome: record.accountHome,
      identity: {
        sessionId: 'source',
        agent: 'codex' as const,
        hostId: 'local',
        workspaceId: 'workspace',
        providerHandle: null
      }
    }
  }
}
it('reopens the confirmed native copy after a failed preparation and host restart', async () => {
  const input = request()
  const store = await openTestAgentSessionRecordStore(root)
  await expect(
    copyStructuredAgentSessionCurrentContext({
      ...input,
      store,
      copy: async ({ onCopyConfirmed }) => {
        await onCopyConfirmed!('native-child')
        throw new AgentConversationCopyStartError('transcript is not readable yet')
      }
    })
  ).rejects.toThrow('transcript is not readable yet')
  await closeTestAgentSessionDatabase(root)
  input.source.record.options = { ...input.source.record.options, model: 'changed-after-copy' }
  input.source.record.permissionMode = 'full-access'
  input.source.record.launchArgs = ['--changed-after-copy']
  const reopened = await openTestAgentSessionRecordStore(root)
  const result = await copyStructuredAgentSessionCurrentContext({
    ...input,
    callerKey: 'reconnected-client',
    store: reopened,
    copy: async ({ copiedSessionId }) => {
      if (copiedSessionId !== 'native-child') {
        throw new Error('would create a duplicate')
      }
      return { sessionId: copiedSessionId, filePath: '/native-child.jsonl' }
    }
  })
  expect(result).toEqual({ sessionId: 'native-child', filePath: '/native-child.jsonl' })
})
it('keeps a lost fork reply uncertain across restart instead of dispatching another copy', async () => {
  const input = request()
  const store = await openTestAgentSessionRecordStore(root)
  await expect(
    copyStructuredAgentSessionCurrentContext({
      ...input,
      store,
      copy: async () => {
        throw new AgentConversationCopyStartError('fork reply lost')
      }
    })
  ).rejects.toThrow('fork reply lost')
  await closeTestAgentSessionDatabase(root)
  const reopened = await openTestAgentSessionRecordStore(root)
  await expect(
    copyStructuredAgentSessionCurrentContext({
      ...input,
      callerKey: 'reconnected-client',
      store: reopened,
      copy: async () => {
        throw new Error('would create a duplicate')
      }
    })
  ).rejects.toMatchObject({ refusal: { code: 'agent_session_operation_unknown' } })
})
it('keeps the inherited context boundary when a confirmed copy is replayed after restart', async () => {
  const input = request()
  const store = await openTestAgentSessionRecordStore(root)
  await copyStructuredAgentSessionCurrentContext({
    ...input,
    store,
    copy: async ({ onCopyConfirmed }) => {
      await onCopyConfirmed!('native-child')
      return {
        sessionId: 'native-child',
        filePath: '/native-child.jsonl',
        coverage: { unit: 'codex-turn', ids: ['inherited-turn'] }
      }
    }
  })
  await closeTestAgentSessionDatabase(root)
  const reopened = await openTestAgentSessionRecordStore(root)
  const replay = await copyStructuredAgentSessionCurrentContext({
    ...input,
    store: reopened,
    copy: async ({ copiedCoverage }) => ({
      sessionId: 'native-child',
      filePath: '/archived/native-child.jsonl',
      coverage: copiedCoverage ?? { unit: 'codex-turn', ids: ['inherited-turn', 'new-side-turn'] }
    })
  })
  expect(replay.coverage).toEqual({ unit: 'codex-turn', ids: ['inherited-turn'] })
})
