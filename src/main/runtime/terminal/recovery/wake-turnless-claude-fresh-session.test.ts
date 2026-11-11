// WAKE-1: a Claude pane that never took a turn wrote no transcript, so the host's wake relaunch must not
// `--resume` it (Claude prints "No conversation found" and the pane is left a bare shell).
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { partialRuntimeStore } from '../../orca-runtime-tests/runtime-store-partial-fixture'

// Preserve side-effect order: mocks, lifecycle, fixtures.
await import('../../orca-runtime-tests/runtime-test-module-registration.spec')
const { OrcaRuntimeService } = await import('../../orca-runtime')
await import('../../orca-runtime-tests/orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('../../orca-runtime-tests/orca-runtime-test-fixtures.spec')
const { committingSpawn } = await import('../../orca-runtime-tests/bind-first-pane.test-fixture')

const PANE_KEY = `host-tab:${HEADLESS_LEAF_ID}`
const SESSION_ID = '81eb0bf5-6f2a-4c8e-9d1b-2a3c4d5e6f70'
const RESUMES = new RegExp(`--resume'? '?${SESSION_ID}`)
const STARTS_FRESH = new RegExp(`--session-id'? '?${SESSION_ID}`)

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orca-wake-transcript-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function claudeRow(transcriptPath: string): AgentStatusIpcPayload {
  return {
    paneKey: PANE_KEY,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath },
    prompt: '',
    state: 'done',
    receivedAt: 1,
    stateStartedAt: 1,
    connectionId: null
  }
}

async function wake(row: AgentStatusIpcPayload): Promise<string> {
  const session = makeWorkspaceSessionWithHeadlessTerminal()
  const [tab] = session.tabsByWorktree[TEST_WORKTREE_ID] ?? []
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
    ...session,
    tabsByWorktree: { [TEST_WORKTREE_ID]: [{ ...tab!, launchAgent: 'claude' }] }
  })
  const spawn = vi.fn(
    async (_args: { worktreeId?: string; tabId?: string; leafId?: string; command?: string }) => ({
      id: 'woken-pty'
    })
  )
  const runtime = new OrcaRuntimeService(partialRuntimeStore(runtimeStore), undefined, {
    getAgentProviderSessionSnapshot: () => [row],
    getAgentProviderSessionRowsForPane: (paneKey: string) => (paneKey === row.paneKey ? [row] : []),
    checkHookAgentPresence: async () => 'exited'
  })
  runtime.setPtyController({
    spawn: committingSpawn(runtime, spawn),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  // The host's own relaunch of the woken pane, which no client asked for.
  await runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, 'host-tab', HEADLESS_LEAF_ID, {
    notifyClients: false,
    navigation: 'caller',
    intent: 'automatic'
  })
  return spawn.mock.calls[0]?.[0].command ?? ''
}

describe('waking a pane whose Claude session is recorded', () => {
  it('starts a turn-less session fresh under its id when its transcript is not on disk', async () => {
    const command = await wake(claudeRow(join(dir, `${SESSION_ID}.jsonl`)))
    expect(command).toMatch(STARTS_FRESH)
    expect(command).not.toMatch(RESUMES)
    expect(command).not.toContain('--resume')
  })

  it('still resumes the session by id when its transcript exists', async () => {
    const transcriptPath = join(dir, `${SESSION_ID}.jsonl`)
    await writeFile(transcriptPath, '{"type":"user"}\n')
    const command = await wake(claudeRow(transcriptPath))
    expect(command).toMatch(RESUMES)
    expect(command).not.toContain('--session-id')
  })
})
