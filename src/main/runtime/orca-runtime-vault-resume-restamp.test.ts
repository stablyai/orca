// L4-m8: the spawning vault-resume path must restamp its fresh local discovery
// MATCH-FIRST, exactly like resolveAiVaultResumeCommand — restamp the whole
// list ONLY when no fresh row already carries the entry's host id. The old
// per-mismatched-row restamp relabeled WSL rows as the entry host, letting a
// same-session-id row from the wrong host match the echoed locator.

import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { findVaultResumeSession } from '../agent-launch/agent-launch-vault-resume'
import type { AiVaultSession } from '../../shared/ai-vault-types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('../agent-launch/agent-launch-vault-resume', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, findVaultResumeSession: vi.fn(() => undefined) }
})

const findMock = vi.mocked(findVaultResumeSession)

function session(executionHostId: string, sessionId: string): AiVaultSession {
  return {
    id: `${executionHostId}:claude:${sessionId}:/t/${sessionId}.jsonl`,
    executionHostId,
    agent: 'claude',
    sessionId,
    filePath: `/t/${sessionId}.jsonl`,
    resumeLocator: `claude --resume ${sessionId}`
  } as unknown as AiVaultSession
}

type Internals = {
  store: unknown
  resolveWorkspaceAgentLaunch: (
    workspace: unknown,
    request: unknown,
    clientKind: undefined
  ) => Promise<unknown>
}

function makeRuntime(sessions: AiVaultSession[]): Internals {
  const runtime = new OrcaRuntimeService()
  const internals = runtime as unknown as Internals
  ;(runtime as unknown as { store: unknown }).store = { getSettings: () => ({}) }
  vi.spyOn(runtime, 'listAiVaultSessions').mockResolvedValue({
    sessions,
    issues: [],
    scannedAt: '2026-01-01T00:00:00.000Z'
  })
  return internals
}

const WORKSPACE = { id: 'wt-1', path: '/wt', connectionId: null, repo: null }

async function resolveFor(entryHostId: string, sessions: AiVaultSession[]): Promise<void> {
  findMock.mockClear()
  const internals = makeRuntime(sessions)
  await internals.resolveWorkspaceAgentLaunch(
    WORKSPACE,
    {
      vaultResume: {
        operation: 'resume',
        entry: {
          executionHostId: entryHostId,
          agent: 'claude',
          sessionId: 'sess-1',
          resumeLocator: 'claude --resume sess-1'
        }
      }
    },
    undefined
  )
}

describe('vault-resume match-first restamp (L4-m8)', () => {
  it('keeps original host ids when a fresh row already carries the entry host', async () => {
    await resolveFor('local', [session('local', 'sess-1'), session('wsl:Ubuntu', 'sess-1')])
    const seen = findMock.mock.calls[0]![1] as AiVaultSession[]
    // Before the fix the WSL row was relabeled 'local' and could shadow the
    // real local row in the locator match.
    expect(seen.map((row) => row.executionHostId).sort()).toEqual(['local', 'wsl:Ubuntu'])
  })

  it('restamps the WHOLE list only when no row matches the entry host (runtime alias)', async () => {
    await resolveFor('runtime:env-1', [session('local', 'sess-1'), session('local', 'sess-2')])
    const seen = findMock.mock.calls[0]![1] as AiVaultSession[]
    expect(seen.every((row) => row.executionHostId === 'runtime:env-1')).toBe(true)
  })
})
