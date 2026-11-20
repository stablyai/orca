import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'

it('keeps the last result across work, a new session boundary and a host restart', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-boundary-completion-'))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_800_000_001_000)
  let server = new AgentHookServer()
  const publish = (state: 'working' | 'done', at: number, boundary = false) => {
    vi.setSystemTime(at)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'codex',
        hookEventName: boundary ? 'SessionStart' : state === 'done' ? 'Stop' : 'UserPromptSubmit',
        hasExplicitPrompt: state === 'working',
        providerSession: { key: 'session_id', id: boundary ? 'next-session' : 'first-session' },
        payload: {
          state,
          prompt: '',
          agentType: 'codex',
          ...(boundary ? { sessionBoundary: true } : {})
        }
      },
      null
    )
  }
  try {
    await server.start({ env: 'production', userDataPath })
    publish('working', 1_800_000_001_000)
    publish('done', 1_800_000_002_000)
    publish('working', 1_800_000_003_000)
    publish('done', 1_800_000_004_000, true)
    expect(server.getStatusSnapshotForPane(PANE)[0]?.lastCompletionAt).toBe(1_800_000_002_000)
    server.flushStatusPersistSync()
    server.stop()
    server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.lastCompletionAt).toBe(1_800_000_002_000)
    publish('done', 1_800_000_005_000)
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      stateStartedAt: 1_800_000_005_000,
      lastCompletionAt: 1_800_000_005_000
    })
  } finally {
    server.stop()
    vi.useRealTimers()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
