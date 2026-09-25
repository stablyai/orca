import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { getActiveNativeChatWatcherCount } from '../transcript-watcher-count'
import {
  CALLER,
  adapter,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import { StructuredHandoffTestRequests } from './structured-agent-session-handoff-test-requests'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from './structured-agent-session-handoff-types'

function rolloutLine(message: string): string {
  return `${JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-11T10:00:00.000Z',
    payload: { type: 'agent_message', message }
  })}\n`
}

function tuiOwner(fence: number, spawnToken: string): StructuredTuiOwner {
  return {
    terminal: { handle: 'term-tui', tabId: 'tab-tui', paneKey: 'pane-tui', ptyId: 'pty-tui' },
    process: { hostId: 'local', pid: 5200, processStartTimeMs: NOW, spawnToken },
    link: {
      linkId: `tui-link-${fence}`,
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'resumed',
      mintedAtFence: fence,
      observedAt: NOW
    }
  }
}

export async function createTuiTranscriptTeardownFixture() {
  const initial = hostTestState()
  await initial.host.flushAllStreamedEvents()
  const watcherBaseline = getActiveNativeChatWatcherCount()
  const closeTuiOwner = vi.fn(async () => ({}))
  const launchTui = vi.fn<StructuredAgentSessionHandoffTransport['launchTui']>(
    async ({ fence, spawnToken }) => tuiOwner(fence, spawnToken)
  )
  const host = new StructuredAgentSessionHost({
    ...initial.host.deps,
    adapter: { ...adapter(), closeSession: vi.fn(async () => true) },
    handoffTransport: {
      hostLabel: 'Test host',
      launchTui,
      reproveTuiOwner: async ({ owner }) => owner,
      recoverTuiOwner: async (record) =>
        tuiOwner(record.lease.runtimeFence, record.lease.reservedSpawnToken ?? 'recovered'),
      stopRecoveredOwner: async () => undefined,
      closeTuiOwner,
      waitForTuiExit: async () => ({}),
      waitForTuiIdleOrExit: async () => 'idle',
      tuiStatus: () => 'idle'
    }
  })
  replaceHostTestState({ host, store: initial.store })
  const accountHome = join(initial.root, 'codex-home')
  const sessionsDir = join(accountHome, 'sessions', '2026', '08', '11')
  await mkdir(sessionsDir, { recursive: true })
  const rollout = join(sessionsDir, `rollout-2026-08-11T10-00-00-${THREAD}.jsonl`)
  await writeFile(rollout, rolloutLine('before handoff'))
  expect(
    await host.attach(
      CALLER,
      hostTestAttachParams(null, { accountHome: { variable: 'CODEX_HOME', path: accountHome } })
    )
  ).toMatchObject({ ok: true })
  const requests = new StructuredHandoffTestRequests(
    NOW,
    SESSION,
    () => initial.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
  )
  return {
    host,
    store: initial.store,
    acquire: initial.acquire,
    launchTui,
    rollout,
    watcherBaseline,
    async requestHandoff() {
      expect(
        await host.requestHandoff(
          CALLER,
          requests.request('to-tui', 'now', { operationId: hostTestOperationId() })
        )
      ).toMatchObject({ ok: true })
    }
  }
}
