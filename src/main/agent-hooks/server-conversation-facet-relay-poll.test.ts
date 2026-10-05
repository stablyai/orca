// A live SSH relay transcript poll reaches the host as an ordinary hook envelope. It repeats the
// relay's latest forwarded address and model, so the host's conversation facet must not move.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import { AgentHookServer } from './server'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: { fromId: () => null },
  webContents: { fromId: () => null },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() }
}))

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'
const line = (record: unknown): string => `${JSON.stringify(record)}\n`

let cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.toReversed()) {
    cleanup()
  }
  cleanups = []
})

type Rig = {
  host: () => AgentHookServer
  relay: RelayAgentHookServer
  forwarded: AgentHookRelayEnvelope[]
  parentPath: string
  childPath: string
  post: (body: Record<string, unknown>) => Promise<void>
  restartHost: () => Promise<void>
}

async function rig(): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-facet-relay-poll-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const parentPath = join(dir, 'rollout-parent.jsonl')
  const childPath = join(dir, `rollout-child-${CHILD_ID}.jsonl`)
  writeFileSync(
    parentPath,
    line({
      type: 'event_msg',
      payload: {
        type: 'sub_agent_activity',
        occurred_at_ms: 1234,
        agent_thread_id: CHILD_ID,
        agent_path: '/root/pr_review',
        kind: 'started'
      }
    })
  )
  writeFileSync(childPath, line({ type: 'event_msg', payload: { type: 'task_started' } }))
  const userDataPath = join(dir, 'host')
  let host = new AgentHookServer()
  await host.start({ env: 'production', userDataPath })
  cleanups.push(() => host.stop())
  const forwarded: AgentHookRelayEnvelope[] = []
  const relay = new RelayAgentHookServer({
    endpointDir: join(dir, 'relay'),
    forward: (envelope) => {
      forwarded.push(envelope)
      host.ingestRemote(envelope, 'ssh-1')
    }
  })
  await relay.start()
  cleanups.push(() => relay.stop())
  const { port, token } = relay.getCoordinates()
  return {
    host: () => host,
    relay,
    forwarded,
    parentPath,
    childPath,
    post: async (payload) => {
      const response = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', payload })
      })
      expect(response.status).toBe(204)
    },
    restartHost: async () => {
      host.flushStatusPersistSync()
      host.stop()
      host = new AgentHookServer()
      await host.start({ env: 'production', userDataPath })
      cleanups.push(() => host.stop())
    }
  }
}

function facetOf(host: AgentHookServer) {
  return host.getConversationIdentityForPane(PANE)?.facet
}

describe('relay transcript polls are no-ops for the conversation facet', () => {
  it('leaves the facet the same object across a poll and a replay of the cached row', async () => {
    const r = await rig()
    await r.post({
      hook_event_name: 'PostToolUse',
      session_id: 'S',
      transcript_path: r.parentPath,
      model: 'P',
      tool_name: 'collaborationspawn_agent'
    })
    const original = r.forwarded[0]
    const before = facetOf(r.host())
    expect(before).toMatchObject({
      agentType: 'codex',
      providerSession: { id: 'S', transcriptPath: r.parentPath },
      model: 'P'
    })

    appendFileSync(r.childPath, line({ type: 'event_msg', payload: { type: 'task_complete' } }))
    await vi.waitFor(() => expect(r.forwarded).toHaveLength(2), { timeout: 2500, interval: 50 })
    const polled = r.forwarded[1]
    expect(polled?.hookEventName).toBeUndefined()
    expect(polled?.providerSession).toEqual(original?.providerSession)
    expect(facetOf(r.host())).toBe(before)

    expect(r.relay.replayCachedPayloadsForPanes()).toBe(1)
    expect(r.forwarded.at(-1)?.isReplay).toBe(true)
    expect(facetOf(r.host())).toBe(before)
  })

  it('restores the persisted facet and leaves it byte-identical across a relay replay', async () => {
    const r = await rig()
    await r.post({
      hook_event_name: 'PostToolUse',
      session_id: 'S',
      transcript_path: r.parentPath,
      model: 'P',
      tool_name: 'collaborationspawn_agent'
    })
    const persisted = JSON.stringify(facetOf(r.host()))
    await r.restartHost()
    expect(JSON.stringify(facetOf(r.host()))).toBe(persisted)
    r.relay.replayCachedPayloadsForPanes()
    expect(JSON.stringify(facetOf(r.host()))).toBe(persisted)
  })

  it('still moves for a genuine relay hook with a new model or a new session', async () => {
    const r = await rig()
    await r.post({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'S',
      transcript_path: r.parentPath,
      model: 'P',
      prompt: 'go'
    })
    const first = facetOf(r.host())
    await r.post({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'S',
      transcript_path: r.parentPath,
      model: 'Q',
      prompt: 'again'
    })
    const moved = facetOf(r.host())
    expect(moved).toMatchObject({ providerSession: { id: 'S' }, model: 'Q' })
    expect(moved).not.toBe(first)
    await r.post({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'T',
      transcript_path: r.childPath,
      prompt: 'new'
    })
    expect(facetOf(r.host())).toMatchObject({ providerSession: { id: 'T' } })
  })
})
