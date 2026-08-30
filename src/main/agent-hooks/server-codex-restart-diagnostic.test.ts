import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

async function postCodexStatus(server: AgentHookServer, transcriptPath: string): Promise<void> {
  const env = server.buildPtyEnv()
  await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/codex`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify({
      paneKey: PANE_KEY,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: 'root-session',
        transcript_path: transcriptPath,
        tool_name: 'collaborationspawn_agent'
      }
    })
  })
}

describe('AgentHookServer Codex restart diagnostics', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it('marks a vanished parent transcript unreadable without a child roster', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-missing-parent-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    writeFileSync(parentPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))
    const first = new AgentHookServer()
    await first.start({ env: 'production', userDataPath: dir })
    try {
      await postCodexStatus(first, parentPath)
    } finally {
      first.stop()
    }
    rmSync(parentPath)

    const second = new AgentHookServer()
    await second.start({ env: 'production', userDataPath: dir })
    try {
      await vi.waitFor(
        () =>
          expect(second.getStatusSnapshot()[0]?.reconcileDiagnostic).toEqual({
            kind: 'unverifiable',
            reason: 'transcript-unreadable',
            observedAt: expect.any(Number)
          }),
        { timeout: 7_000, interval: 100 }
      )
    } finally {
      second.stop()
    }
  })

  it('clears a persisted transcript diagnostic after the parent becomes readable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-hook-codex-parent-recovery-'))
    dirs.push(dir)
    const parentPath = join(dir, 'rollout-parent.jsonl')
    const cachePath = join(dir, 'agent-hooks', 'last-status.json')
    const seed = new AgentHookServer()
    await seed.start({ env: 'production', userDataPath: dir })
    try {
      await postCodexStatus(seed, parentPath)
    } finally {
      seed.stop()
    }
    const persisted = JSON.parse(readFileSync(cachePath, 'utf8')) as {
      entries: Record<string, Record<string, unknown>>
    }
    persisted.entries[PANE_KEY] = {
      ...persisted.entries[PANE_KEY],
      reconcileDiagnostic: {
        kind: 'unverifiable',
        reason: 'transcript-unreadable',
        observedAt: 123
      }
    }
    writeFileSync(cachePath, JSON.stringify(persisted))
    writeFileSync(parentPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))

    const recovered = new AgentHookServer()
    await recovered.start({ env: 'production', userDataPath: dir })
    try {
      await vi.waitFor(
        () => expect(recovered.getStatusSnapshot()[0]?.reconcileDiagnostic).toBeNull(),
        { timeout: 2_500, interval: 50 }
      )
    } finally {
      recovered.stop()
    }
  })

  it('releases generation fences when unique Codex panes are cleared', () => {
    const server = new AgentHookServer()
    for (let index = 0; index < 512; index += 1) {
      const paneKey = makePaneKey(`tab-${index}`, '11111111-1111-4111-8111-111111111111')
      server.ingestRemote(
        {
          paneKey,
          tabId: `tab-${index}`,
          hookEventName: 'SessionStart',
          source: 'codex',
          payload: { state: 'working', prompt: 'new turn', agentType: 'codex' }
        },
        'connection-1'
      )
      server.clearPaneState(paneKey)
    }

    expect(server._getCodexPaneGenerationCountForTests()).toBe(0)
  })
})
