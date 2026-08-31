import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const CLAUDE_SESSION = 'claude-session'
const hosts: StructuredAgentSessionHost[] = []
let root = ''

function claudeAdapter(): StructuredAgentSessionAdapter {
  return {
    supportsCreate: (_location, agent) => agent === 'claude',
    acquire: async ({ fence, spawnToken }) => ({
      process: {
        hostId: 'local',
        pid: 4242,
        processStartTimeMs: 1_700_000_000_000,
        spawnToken
      },
      link: {
        linkId: `link-${fence}`,
        handle: { provider: 'claude', sessionId: CLAUDE_SESSION, leafUuid: null },
        origin: 'created',
        mintedAtFence: fence,
        observedAt: HOST_TEST_NOW
      }
    }),
    dispatch: async () => ({ state: 'rejected', reason: 'unused' }),
    cancelTurn: async () => ({ cancelled: false }),
    answerPrompt: async () => undefined,
    setOption: async () => undefined
  }
}

function createHost(
  store: AgentSessionRecordStore,
  probeOwner?: StructuredAgentSessionHost['deps']['probeOwner']
): StructuredAgentSessionHost {
  const host = new StructuredAgentSessionHost({
    store,
    adapter: claudeAdapter(),
    journalRoot: root,
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-a',
    probeOwner,
    now: () => HOST_TEST_NOW
  })
  hosts.push(host)
  return host
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.flushAllStreamedEvents()))
  await rm(root, { recursive: true, force: true })
  root = ''
})

describe('structured session provider restore', () => {
  it('restores a durable Claude session tab with its recorded provider', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-provider-restore-'))
    resetHostTestOperationIds()
    const storeDirectory = join(root, 'store')
    const store = await AgentSessionRecordStore.open({ directory: storeDirectory, hostId: 'local' })
    const host = createHost(store)
    const attached = await host.attach(
      { callerKey: 'client-1' },
      hostTestAttachParams(null, {
        provider: 'claude',
        agent: 'claude',
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude' },
        providerHandle: { kind: 'claude', sessionId: CLAUDE_SESSION, leafUuid: null }
      })
    )
    expect(attached).toMatchObject({ ok: true })

    const reopenedStore = await AgentSessionRecordStore.open({
      directory: storeDirectory,
      hostId: 'local'
    })
    const restarted = createHost(reopenedStore, async () => ({
      outcome: 'indeterminate',
      reason: 'read does not need ownership'
    }))

    await restarted.restoreReadableSessions()

    expect(restarted.listSessionTabs()).toEqual([
      { sessionId: HOST_TEST_SESSION, workspaceId: 'workspace-1', agent: 'claude' }
    ])
  })
})
