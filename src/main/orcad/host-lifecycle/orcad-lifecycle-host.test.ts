import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  CALLER,
  hostTestState
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host.test-fixture'
import {
  HOST_TEST_THREAD as THREAD,
  HOST_TEST_NOW as NOW,
  hostTestAttachParams,
  hostTestOperationId
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { AgentSessionRecoveryCapsule } from '../../runtime/agent-session/records/agent-session-recovery-capsule'
import { OrcadProfileShutdown } from '../host-runtime/orcad-profile-shutdown'
import { Store } from '../../persistence/loading-store/store'
import {
  closeTestStores,
  createSqliteTestStore,
  readPersistedStateJson
} from '../../persistence/persistence-test-harness'
import { readFile } from 'node:fs/promises'
import { holdRemovalMetadata } from '../../workspaces/removal/worktree-removal-lifetime.test-fixtures'
import { readWorktreeRemovalRecords } from '../../workspaces/removal/worktree-removal-records'
import { _resetPendingWorktreeRemovalsForTests } from '../../workspaces/removal/worktree-background-removal'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../browser-providers/orcad-browser-startup', () => ({
  startOrcadBrowserProvider: () => ({ ready: Promise.resolve(), stop: async () => {} })
}))

import { ORCAD_LOCK_FILE_NAME } from '../instance-lock/orcad-instance-lock'
import { worktreeRemovalLifetime } from '../../workspaces/removal/worktree-removal-lifetime'
import {
  startOrcadWithHost,
  startOrcadWithLifecycle,
  stopOrcadStructuredAgentSessions
} from './orcad-lifecycle'

const roots: string[] = []
afterEach(async () => {
  await closeTestStores()
  vi.restoreAllMocks()
  vi.useRealTimers()
  _resetPendingWorktreeRemovalsForTests()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function dataRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-lifecycle-host-'))
  roots.push(root)
  return root
}

describe('startOrcadWithHost', () => {
  it('keeps the instance lock when a runtime writer could not be stopped', async () => {
    const root = dataRoot()
    const failure = new Error('profile writer still running')
    const handle = await startOrcadWithHost(
      root,
      async (registerCleanup) => {
        registerCleanup(() => {
          throw failure
        })
        return {}
      },
      () => {}
    )
    await expect(handle.stop()).rejects.toBe(failure)
    expect(existsSync(join(root, ORCAD_LOCK_FILE_NAME))).toBe(true)
  })
})

vi.mock('../../runtime/agent-session/structured-agent-session-runtime', () => ({
  stopStructuredAgentSessionRuntime: async (options: { trigger: 'quit' }) => {
    await hostTestState().host.flushAllStreamedEvents(options)
  }
}))

it('saves working-chat offers before profile cleanup and keeps them after repeated stop', async () => {
  const { host, acquire, root } = hostTestState()
  const ids = ['session-first', 'session-second']
  for (const sessionId of ids) {
    const params = hostTestAttachParams(null, {
      envelope: {
        sessionId,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      }
    })
    expect(await host.attach(CALLER, params)).toMatchObject({ ok: true })
    const events = acquire.mock.calls.at(-1)?.[0].events
    if (!events) {
      throw new Error('missing provider event sink')
    }
    events.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'working', ordinal: 1 },
      { kind: 'turn', turnId: 'working', state: 'running' },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(sessionId)
  }
  const close = vi.fn(async () => true)
  host.deps.adapter.closeSession = close
  const server = await startOrcadWithLifecycle(
    async (register) => {
      register(async () => {
        expect(
          (await new AgentSessionRecoveryCapsule(root).list(NOW)).map((row) => row.sessionId).sort()
        ).toEqual([...ids].sort())
      })
      register(stopOrcadStructuredAgentSessions)
      return {}
    },
    async () => {}
  )
  await server.stop()
  await server.stop()
  expect(
    (await host.restartResume.list())
      .map(({ sessionId, trigger }) => ({ sessionId, trigger }))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  ).toEqual(
    [...ids]
      .sort((left, right) => left.localeCompare(right))
      .map((sessionId) => ({ sessionId, trigger: 'quit' }))
  )
})

it('joins successful removal metadata and journal before profile ownership is released', async () => {
  vi.useFakeTimers()
  const root = dataRoot()
  const profile = new OrcadProfileShutdown()
  const dataFile = join(root, 'orca-data.json')
  const store = createSqliteTestStore(Store, { dataFile })
  profile.store = store
  await profile.store.flushPendingOrThrowAsync({ fullCheckpoint: true })
  store.getWorkspaceSession().activeTabId = 'before-stop'
  const savedTab = () => JSON.parse(readPersistedStateJson(dataFile)).workspaceSession.activeTabId
  let pending!: Awaited<ReturnType<typeof holdRemovalMetadata>>
  let transportStopped!: () => void
  const transport = new Promise<void>((resolve) => {
    transportStopped = resolve
  })
  let checkpointing: Promise<void> | undefined
  const handle = await startOrcadWithHost(
    root,
    async (registerCleanup) => {
      registerCleanup(profile.finalize)
      registerCleanup(() => worktreeRemovalLifetime.close())
      pending = await holdRemovalMetadata(root, () => {
        store.getWorkspaceSession().activeTabId = 'after-delete'
      })
      registerCleanup(async () => {
        transportStopped()
      })
      return {}
    },
    () => {},
    () => (checkpointing = profile.checkpoint())
  )
  const stopping = handle.stop()
  await transport
  expect(() => worktreeRemovalLifetime.acquirePreparation()).toThrow('Orca is stopping')
  expect(existsSync(join(root, ORCAD_LOCK_FILE_NAME))).toBe(true)
  expect(await readWorktreeRemovalRecords(root)).toHaveLength(1)
  await checkpointing
  expect(savedTab()).toBe('before-stop')
  pending.release()
  await stopping
  await pending.result
  expect(await readFile(join(root, 'metadata-finished'), 'utf8')).toBe('removed')
  expect(await readWorktreeRemovalRecords(root)).toEqual([])
  expect(savedTab()).toBe('after-delete')
  expect(existsSync(join(root, ORCAD_LOCK_FILE_NAME))).toBe(false)
})
