import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store'
import { StructuredTuiTranscriptCatchup } from './structured-tui-transcript-catchup'

const NOW = 1_800_000_000_000
const SESSION = 'session-catchup'
const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'

let root: string
let store: AgentSessionRecordStore

function rolloutLine(message: string): string {
  return `${JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-08-11T10:00:00.000Z',
    payload: { type: 'agent_message', message }
  })}\n`
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-tui-catchup-'))
  store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function createCatchupFixture() {
  const accountHome = join(root, 'isolated-codex-home')
  const sessionsDir = join(accountHome, 'sessions', '2026', '08', '11')
  const rollout = join(sessionsDir, `rollout-2026-08-11T10-00-00-${THREAD}.jsonl`)
  await mkdir(sessionsDir, { recursive: true })
  await writeFile(rollout, rolloutLine('before handoff'), 'utf8')
  const reserved = await store.reserveOwner({
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: accountHome },
    runtimeKind: 'tui',
    expectedFence: null,
    spawnToken: 'tui-token',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'test',
      operationId: `${NOW}-${'1'.padStart(32, '0')}`,
      fingerprint: 'initial'
    },
    now: NOW
  })
  const fence = reserved.record.lease.runtimeFence
  await store.commitProcessIdentity({
    sessionId: SESSION,
    fence,
    process: {
      hostId: 'local',
      pid: 4200,
      processStartTimeMs: NOW - 1_000,
      spawnToken: 'tui-token'
    },
    now: NOW
  })
  await store.proveOwner({
    sessionId: SESSION,
    fence,
    link: {
      linkId: 'tui-link',
      handle: { provider: 'codex', threadId: THREAD },
      origin: 'created',
      mintedAtFence: fence,
      observedAt: NOW
    },
    now: NOW
  })
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    journalDir: join(root, 'journal')
  })
  return { fence, journal, rollout }
}

function createCatchup(input: Awaited<ReturnType<typeof createCatchupFixture>>) {
  return new StructuredTuiTranscriptCatchup({
    store,
    session: () => ({
      hasProviderChild: false,
      journal: input.journal,
      params: {} as never,
      fence: input.fence
    }),
    schedule: async (_sessionId, task) => task(),
    publish: vi.fn(),
    reset: vi.fn()
  })
}

describe('StructuredTuiTranscriptCatchup', () => {
  it('tails only TUI-era appends from the durable account home', async () => {
    const fixture = await createCatchupFixture()
    const catchup = createCatchup(fixture)

    await catchup.prepare(SESSION, fixture.fence)
    await catchup.activate(SESSION)
    expect(fixture.journal.snapshot().items).toEqual([])

    await appendFile(fixture.rollout, rolloutLine('during TUI'), 'utf8')
    await vi.waitFor(() =>
      expect(fixture.journal.snapshot().items.map((item) => item.body)).toContainEqual({
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'during TUI' }]
      })
    )

    catchup.stop(SESSION)
    await appendFile(fixture.rollout, rolloutLine('after stop'), 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(fixture.journal.snapshot().items).toHaveLength(1)
  })

  it('replays transcript writes made while the host watcher was down', async () => {
    const fixture = await createCatchupFixture()
    const beforeCrash = createCatchup(fixture)
    await beforeCrash.prepare(SESSION, fixture.fence)
    await beforeCrash.activate(SESSION)
    await appendFile(fixture.rollout, rolloutLine('before host crash'), 'utf8')
    await vi.waitFor(() => expect(fixture.journal.snapshot().items).toHaveLength(1))
    beforeCrash.stopAll()

    await appendFile(fixture.rollout, rolloutLine('while host was down'), 'utf8')
    const recovered = createCatchup(fixture)
    await recovered.recover(SESSION, fixture.fence)
    await recovered.activate(SESSION)

    const text = fixture.journal
      .snapshot()
      .items.flatMap((item) =>
        item.body.kind === 'message'
          ? item.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
          : []
      )
    expect(text).toEqual(['before host crash', 'while host was down'])
    recovered.stopAll()
  })
})
