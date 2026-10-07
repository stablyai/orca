import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FORK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

describe('RelayAgentHookServer Claude session continuation', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    dirs.length = 0
  })

  it("forwards the pane's rebinding to the fork its transcript names", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-hook-claude-continuation-'))
    dirs.push(dir)
    const projectDir = join(dir, 'claude', 'projects', '-work-repo')
    mkdirSync(projectDir, { recursive: true })
    const oldPath = join(projectDir, `${OLD}.jsonl`)
    const forkPath = join(projectDir, `${FORK}.jsonl`)
    writeFileSync(
      oldPath,
      line({ type: 'user', sessionId: OLD, uuid: 'u1' }) +
        line({ type: 'continued-in', sessionId: OLD, continuedInSessionId: FORK })
    )
    writeFileSync(forkPath, line({ type: 'user', sessionId: FORK, uuid: 'u1' }))
    const forward = vi.fn<(envelope: AgentHookRelayEnvelope) => void>()
    const server = new RelayAgentHookServer({ endpointDir: dir, forward })
    await server.start()
    try {
      const { port, token } = server.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          payload: {
            hook_event_name: 'UserPromptSubmit',
            session_id: OLD,
            transcript_path: oldPath,
            prompt: 'keep going'
          }
        })
      })
      expect(response.status).toBe(204)
      const prompted = forward.mock.calls.at(-1)?.[0]
      expect(prompted?.providerSession?.id).toBe(OLD)

      await server.checkAgentPresence(PANE_KEY)

      const rebound = forward.mock.calls.at(-1)?.[0]
      expect(rebound?.providerSession).toEqual({
        key: 'session_id',
        id: FORK,
        transcriptPath: forkPath
      })
      expect(rebound?.isReplay).toBe(true)
      expect(rebound?.payload.state).toBe(prompted?.payload.state)
    } finally {
      server.stop()
    }
  })
})
