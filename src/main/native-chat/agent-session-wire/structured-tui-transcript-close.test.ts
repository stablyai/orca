import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
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

let host: StructuredAgentSessionHost
let rollout: string
let watcherBaseline: number
let closeTuiOwner: ReturnType<
  typeof vi.fn<NonNullable<StructuredAgentSessionHandoffTransport['closeTuiOwner']>>
>

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

async function expectTranscriptMessage(text: string): Promise<void> {
  await appendFile(rollout, rolloutLine(text))
  await vi.waitFor(() => {
    const history = host.history({ sessionId: SESSION, direction: 'tail' })
    expect(
      history.ok &&
        history.page.items.some(
          (item) =>
            item.body.kind === 'message' &&
            item.body.blocks.some((block) => block.type === 'text' && block.text === text)
        )
    ).toBe(true)
  })
}

beforeEach(async () => {
  const initial = hostTestState()
  await initial.host.flushAllStreamedEvents()
  watcherBaseline = getActiveNativeChatWatcherCount()
  closeTuiOwner = vi.fn(async () => ({}))
  host = new StructuredAgentSessionHost({
    ...initial.host.deps,
    adapter: { ...adapter(), closeSession: vi.fn(async () => true) },
    handoffTransport: {
      hostLabel: 'Test host',
      launchTui: async ({ fence, spawnToken }) => tuiOwner(fence, spawnToken),
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
  rollout = join(sessionsDir, `rollout-2026-08-11T10-00-00-${THREAD}.jsonl`)
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
  expect(
    await host.requestHandoff(
      CALLER,
      requests.request('to-tui', 'now', { operationId: hostTestOperationId() })
    )
  ).toMatchObject({ ok: true })
  await host['handoffs'].drain()
  expect(await host.handoffStatus(SESSION)).toMatchObject({ owner: 'tui', phase: 'idle' })
  expect(getActiveNativeChatWatcherCount()).toBe(watcherBaseline + 1)
})

it('retires the transcript watcher when a live TUI session closes', async () => {
  await expectTranscriptMessage('while TUI live')
  await host.close(SESSION)
  expect(host.hasSession(SESSION)).toBe(false)
  expect(hostTestState().store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
  expect(getActiveNativeChatWatcherCount()).toBe(watcherBaseline)
  await appendFile(rollout, rolloutLine('after TUI close'))
  await host.close(SESSION)
  expect(closeTuiOwner).toHaveBeenCalledOnce()
  expect(getActiveNativeChatWatcherCount()).toBe(watcherBaseline)
})

it('keeps live history when terminal stop is unverified and retires it on retry', async () => {
  closeTuiOwner.mockRejectedValueOnce(new Error('terminal exit unverified'))
  await expect(host.close(SESSION)).rejects.toThrow('terminal exit unverified')
  expect(host.hasSession(SESSION)).toBe(true)
  expect(hostTestState().store.getRecord(SESSION)?.lease.claimStatus).toBe('live')
  expect(getActiveNativeChatWatcherCount()).toBe(watcherBaseline + 1)
  await expectTranscriptMessage('after unverified stop')
  await host.close(SESSION)
  expect(closeTuiOwner).toHaveBeenCalledTimes(2)
  expect(getActiveNativeChatWatcherCount()).toBe(watcherBaseline)
})

it('keeps the watcher until the durable owner transition succeeds', async () => {
  vi.spyOn(hostTestState().store, 'transitionHandoff').mockRejectedValueOnce(
    new Error('lease write failed')
  )
  await expect(host.close(SESSION)).rejects.toThrow('lease write failed')
  expect(host.hasSession(SESSION)).toBe(true)
  expect(getActiveNativeChatWatcherCount()).toBe(watcherBaseline + 1)
  await host.close(SESSION)
  expect(closeTuiOwner).toHaveBeenCalledTimes(2)
  expect(getActiveNativeChatWatcherCount()).toBe(watcherBaseline)
})

it('keeps transcript cleanup complete when later journal eviction needs retry', async () => {
  const session = host['sessions'].get(SESSION)
  expect(session).toBeDefined()
  if (!session) {
    throw new Error('TUI session missing')
  }
  vi.spyOn(session.journal, 'close').mockRejectedValueOnce(new Error('journal close failed'))
  await expect(host.close(SESSION)).rejects.toThrow('forget-session')
  expect(host.hasSession(SESSION)).toBe(true)
  expect(getActiveNativeChatWatcherCount()).toBe(watcherBaseline)
  await host.close(SESSION)
  expect(host.hasSession(SESSION)).toBe(false)
  expect(closeTuiOwner).toHaveBeenCalledOnce()
  expect(getActiveNativeChatWatcherCount()).toBe(watcherBaseline)
})
