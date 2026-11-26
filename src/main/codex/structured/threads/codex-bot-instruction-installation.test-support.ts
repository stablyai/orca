import type { CodexAppServerConnection } from '../../app-server/codex-app-server-connection-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { openTestAgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  storedTestAgentSessionRecord,
  withTestAgentSessionDatabase
} from '../../../runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { recordStartedHandle } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-start-provider-answer'
import { createStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { createBotTurnContext } from '../../../bots/bot-turn-context'
import { installCodexBotInstructions } from './codex-bot-instruction-installation'

export const NOW = 1_800_000_000_000
export const SNAPSHOT = {
  botId: 'release-manager',
  standing: 'a'.repeat(64),
  digest: 'b'.repeat(64),
  text: 'You are Release Manager.\n## Tools\nUse Orca.\n## Rules\nOwner approval required.',
  baseline: {
    soul: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    memory: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    skills: null
  }
}
export let root: string
export let store: AgentSessionRecordStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-instruction-receipt-'))
  store = await openTestAgentSessionRecordStore(root)
  await store.reserveOwner({
    sessionId: 'release-chat',
    provider: 'codex',
    location: {
      executionHostId: 'local',
      workspaceKind: 'folder',
      workspaceId: 'folder:release',
      wslDistro: null
    },
    accountHome: { variable: 'CODEX_HOME', path: '/isolated/codex' },
    expectedFence: null,
    spawnToken: 'spawn-1',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'owner',
      operationId: `${NOW}-${'1'.repeat(32)}`,
      fingerprint: 'reserve'
    },
    now: NOW
  })
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

export function install(
  request: CodexAppServerConnection['request'] = vi.fn(async () => ({})),
  signal = new AbortController().signal,
  fresh = false,
  options: { historyUnchanged?: boolean } = {}
) {
  return installCodexBotInstructions({
    installation: { store, snapshot: SNAPSHOT, account: '/isolated/codex' },
    connection: { request },
    sessionId: 'release-chat',
    nativeId: 'native-release',
    generation: 'generation-1',
    anchor: 'anchor-1',
    fence: store.getRecord('release-chat')!.lease.runtimeFence,
    fresh,
    historyUnchanged: options.historyUnchanged ?? true,
    signal,
    assertCurrent: () => signal.throwIfAborted()
  })
}

export function openedContext(): Parameters<typeof recordStartedHandle>[0] {
  const turnContext = createBotTurnContext({
    readText: async () => null,
    writeText: async () => false,
    replaceText: async () => false
  })
  turnContext.configureInstructions?.('release-chat', SNAPSHOT, { soul: null, memory: null })
  return {
    deps: { store, logger: createStructuredAgentSessionLogger(), turnContext },
    now: () => NOW
  }
}

export async function recordInstallation(fresh = false) {
  if (!fresh) {
    const fence = store.getRecord('release-chat')!.lease.runtimeFence
    await store.updateRecord('release-chat', {
      kind: 'provider-handle',
      args: {
        fence,
        now: NOW,
        link: {
          linkId: 'seed-anchor',
          handle: codexProviderHandle('native-release'),
          origin: 'created',
          mintedAtFence: fence,
          observedAt: NOW
        }
      }
    })
  }
  const { policy, filesIncluded } = await install(undefined, undefined, fresh)
  const link = {
    linkId: 'anchor-1',
    handle: codexProviderHandle('native-release'),
    origin: fresh ? ('created' as const) : ('resumed' as const),
    mintedAtFence: policy.fence,
    observedAt: NOW
  }
  const event = {
    sessionId: 'release-chat',
    fence: policy.fence,
    acquisitionGeneration: 'generation-1',
    link,
    reportedOptions: {},
    instructionPolicy: policy,
    instructionContext: { digest: SNAPSHOT.digest, account: '/isolated/codex', filesIncluded }
  }
  expect(await recordStartedHandle(openedContext(), event)).toBe(true)
  return event
}

export async function reopenInstallationStore(): Promise<void> {
  store = await openTestAgentSessionRecordStore(root)
}

/** Seed explicitly legacy or moved record shapes, then load through the real parser. */
export async function seedInstallationRecord(
  transform: (record: AgentSessionRecord) => AgentSessionRecord
): Promise<void> {
  const stored = storedTestAgentSessionRecord(transform(store.getRecord('release-chat')!))
  await withTestAgentSessionDatabase(root, (db) =>
    db
      .prepare('UPDATE agent_session_records SET record_json=? WHERE session_id=?')
      .run(JSON.stringify(stored), 'release-chat')
  )
  await reopenInstallationStore()
}
