import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as agentHookListener from '../../shared/agent-hook-listener'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function hookBody(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    env: 'production',
    payload
  }
}

async function postGrokHook(
  endpoint: { port: string; token: string },
  payload: Record<string, unknown>
): Promise<Response> {
  return fetch(`http://127.0.0.1:${endpoint.port}/hook/grok`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify(hookBody(payload))
  })
}

describe('AgentHookServer Grok discovery retries', () => {
  it('waits for delayed discovery beyond the transcript retry window', async () => {
    let releaseDiscovery!: () => void
    const discovery = new Promise<void>((resolve) => {
      releaseDiscovery = resolve
    })
    vi.spyOn(agentHookListener, 'preparePendingGrokResultDiscovery').mockReturnValue(discovery)
    const server = new AgentHookServer()
    const root = mkdtempSync(join(tmpdir(), 'orca-grok-delayed-discovery-'))
    const sessionId = '019e37f4-5135-7b63-a4ab-6d13aa6bf532'
    const cwd = join(root, 'workspace')
    const sessionDir = join(root, '.grok', 'sessions', encodeURIComponent(cwd), sessionId)
    mkdirSync(sessionDir, { recursive: true })
    const history = join(sessionDir, 'chat_history.jsonl')
    writeFileSync(history, '')
    vi.stubEnv('HOME', root)
    vi.stubEnv('USERPROFILE', root)
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const endpoint = { port: env.ORCA_AGENT_HOOK_PORT, token: env.ORCA_AGENT_HOOK_TOKEN }
      const listener = vi.fn()
      server.setListener(listener)

      await postGrokHook(endpoint, { hookEventName: 'UserPromptSubmit', prompt: 'delayed result' })
      await postGrokHook(endpoint, { hookEventName: 'Stop', sessionId, cwd })
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(listener.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBeUndefined()

      writeFileSync(
        history,
        `${JSON.stringify({ type: 'assistant', content: 'Found after discovery.' })}\n`
      )
      releaseDiscovery()

      await vi.waitFor(() => {
        expect(listener.mock.calls.at(-1)?.[0].payload.lastAssistantMessage).toBe(
          'Found after discovery.'
        )
      })
    } finally {
      server.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('does not overwrite a newer same-text prompt when delayed discovery completes', async () => {
    let releaseDiscovery!: () => void
    const discovery = new Promise<void>((resolve) => {
      releaseDiscovery = resolve
    })
    vi.spyOn(agentHookListener, 'preparePendingGrokResultDiscovery').mockReturnValue(discovery)
    const server = new AgentHookServer()
    const root = mkdtempSync(join(tmpdir(), 'orca-grok-stale-discovery-'))
    vi.stubEnv('HOME', root)
    vi.stubEnv('USERPROFILE', root)
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const endpoint = { port: env.ORCA_AGENT_HOOK_PORT, token: env.ORCA_AGENT_HOOK_TOKEN }
      await postGrokHook(endpoint, { hookEventName: 'UserPromptSubmit', prompt: 'old prompt' })
      await postGrokHook(endpoint, {
        hookEventName: 'Stop',
        sessionId: '019e37f4-5135-7b63-a4ab-6d13aa6bf533',
        cwd: join(root, 'workspace')
      })
      await postGrokHook(endpoint, { hookEventName: 'UserPromptSubmit', prompt: 'old prompt' })

      releaseDiscovery()
      await new Promise((resolve) => setTimeout(resolve, 80))

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ state: 'working', prompt: 'old prompt', agentType: 'grok' })
      ])
    } finally {
      server.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
