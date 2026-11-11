import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { retireRestoredStatusesWithDeadTerminals } from '../../../observations/restored-status-dead-terminal-sweep'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

let directory: string
const servers: AgentHookServer[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-crash-turn-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000_000_000)
})

afterEach(() => {
  for (const server of servers) {
    server.stop()
  }
  servers.length = 0
  vi.useRealTimers()
  rmSync(directory, { recursive: true, force: true })
})

async function openServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({
    env: 'production',
    userDataPath: directory
  })
  return server
}

async function codex(server: AgentHookServer, payload: Record<string, unknown>): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ session_id: 'saved-thread', ...payload }),
    '/hook/codex'
  )
  expect(response.status).toBe(204)
}

it('keeps a committed completion through crash hydration and repeated same-thread resume', async () => {
  const before = await openServer()
  await codex(before, { hook_event_name: 'UserPromptSubmit', prompt: 'inspect the workspace' })
  vi.setSystemTime(2_000_000_001_000)
  await codex(before, { hook_event_name: 'Stop', last_assistant_message: 'inspection finished' })
  expect(before.flushStatusPersistSync()).toBe(true)

  // Read the committed state without running the previous runtime's quit path.
  const restored = await openServer()
  vi.setSystemTime(2_000_000_010_000)
  await codex(restored, { hook_event_name: 'SessionStart', source: 'resume' })
  await codex(restored, { hook_event_name: 'SessionStart', source: 'resume' })
  expect(restored.getPublicStatusSnapshotForPane(PANE)).toMatchObject([
    {
      state: 'done',
      prompt: 'inspect the workspace',
      lastAssistantMessage: 'inspection finished',
      providerSession: { id: 'saved-thread' },
      stateStartedAt: 2_000_000_001_000,
      turnEndedAt: 2_000_000_001_000,
      turnEndDisposition: 'identified',
      mainAgent: { state: 'done', stateStartedAt: 2_000_000_001_000 }
    }
  ])
  expect(restored.getPublicStatusSnapshotForPane(PANE)[0].sessionBoundary).toBeUndefined()
  await codex(restored, { hook_event_name: 'Stop' })
  expect(restored.getPublicStatusSnapshotForPane(PANE)).toMatchObject([
    {
      prompt: 'inspect the workspace',
      lastAssistantMessage: 'inspection finished',
      turnEndedAt: 2_000_000_001_000
    }
  ])
  expect(restored.flushStatusPersistSync()).toBe(true)
  const reopened = await openServer()
  expect(reopened.getPublicStatusSnapshotForPane(PANE)).toMatchObject([
    {
      prompt: 'inspect the workspace',
      lastAssistantMessage: 'inspection finished',
      turnEndedAt: 2_000_000_001_000
    }
  ])
})

it('marks an unfinished turn unconfirmed if idle resume arrives before the PTY sweep', async () => {
  const before = await openServer()
  await codex(before, { hook_event_name: 'UserPromptSubmit', prompt: 'unfinished work' })
  expect(before.flushStatusPersistSync()).toBe(true)
  const restored = await openServer()
  vi.setSystemTime(2_000_000_010_000)
  await codex(restored, { hook_event_name: 'SessionStart', source: 'resume' })
  vi.setSystemTime(2_000_000_020_000)
  await codex(restored, { hook_event_name: 'SessionStart', source: 'resume' })
  expect(restored.getPublicStatusSnapshotForPane(PANE)).toMatchObject([
    {
      state: 'done',
      prompt: 'unfinished work',
      mainAgent: { state: 'done', outcome: 'unconfirmed', stateStartedAt: 2_000_000_010_000 }
    }
  ])
  expect(restored.getPublicStatusSnapshotForPane(PANE)[0].turnEndedAt).toBeUndefined()
  await codex(restored, { hook_event_name: 'UserPromptSubmit', prompt: 'new work' })
  expect(restored.getPublicStatusSnapshotForPane(PANE)).toMatchObject([
    { state: 'working', prompt: 'new work', mainAgent: { state: 'working' } }
  ])
})

it('preserves SSH folder history without applying it to newer work or another host', async () => {
  const before = await openServer()
  const identity = {
    paneKey: PANE,
    worktreeId: 'folder:workspace-1',
    source: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: 'remote-thread' }
  }
  before.ingestRemote(
    {
      ...identity,
      hookEventName: 'Stop',
      payload: {
        state: 'done',
        agentType: 'codex',
        prompt: 'remote work',
        lastAssistantMessage: 'remote result'
      }
    },
    'ssh-a'
  )
  expect(before.flushStatusPersistSync()).toBe(true)
  const restored = await openServer()
  const boundary = {
    ...identity,
    hookEventName: 'SessionStart',
    payload: {
      state: 'done' as const,
      agentType: 'codex' as const,
      prompt: '',
      sessionBoundary: true
    }
  }
  restored.ingestRemote(boundary, 'ssh-a')
  expect(restored.getPublicStatusSnapshotForPane(PANE)).toMatchObject([
    {
      prompt: 'remote work',
      lastAssistantMessage: 'remote result',
      stateStartedAt: 2_000_000_000_000
    }
  ])
  restored.ingestRemote(
    {
      ...identity,
      hookEventName: 'UserPromptSubmit',
      hasExplicitPrompt: true,
      payload: { state: 'working', agentType: 'codex', prompt: 'new remote work' }
    },
    'ssh-a'
  )
  restored.ingestRemote({ ...boundary, isReplay: true }, 'ssh-a')
  expect(restored.getPublicStatusSnapshotForPane(PANE)).toMatchObject([
    { state: 'working', prompt: 'new remote work' }
  ])
  restored.ingestRemote(boundary, 'ssh-b')
  expect(restored.getPublicStatusSnapshotForPane(PANE)).toMatchObject([
    { state: 'done', prompt: '', connectionId: 'ssh-b', sessionBoundary: true }
  ])
  expect(restored.getPublicStatusSnapshotForPane(PANE)[0].lastAssistantMessage).toBeUndefined()
})

it('retains a visible interrupted conversation when a restored PTY is proven absent', async () => {
  const before = await openServer()
  await codex(before, { hook_event_name: 'UserPromptSubmit', prompt: 'unfinished work' })
  expect(before.flushStatusPersistSync()).toBe(true)
  const restored = await openServer()
  const sweep = () =>
    retireRestoredStatusesWithDeadTerminals({
      server: restored,
      probePtyLiveness: async () => false,
      isLocalExecutionHost: () => true,
      getBoundPtyIdForPaneKey: () => undefined,
      getPersistedPtyIdForPaneKey: () => 'lost-pty'
    })
  expect(await sweep()).toBe(1)
  expect(restored.getPublicStatusSnapshotForPane(PANE)).toMatchObject([
    {
      state: 'done',
      prompt: 'unfinished work',
      providerSession: { id: 'saved-thread' },
      mainAgent: { state: 'done', outcome: 'interruption' }
    }
  ])
  expect(restored.getPublicStatusSnapshotForPane(PANE)[0].turnEndedAt).toBeUndefined()
  expect(await sweep()).toBe(0)
  expect(restored.flushStatusPersistSync()).toBe(true)
  const reopened = await openServer()
  await codex(reopened, { hook_event_name: 'SessionStart', source: 'resume' })
  expect(reopened.getPublicStatusSnapshotForPane(PANE)).toMatchObject([
    { prompt: 'unfinished work', mainAgent: { state: 'done', outcome: 'interruption' } }
  ])
})
