import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { normalizeHookPayload } from '../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { InProcessAgentIdentityClient } from '../../../identity/agent-identity-client.test-fixtures'
import type { AgentIdentityClient } from '../../../identity/agent-identity-worker-client'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody } from '../server.test-fixtures'

const WSL = 'wsl:Ubuntu'
const PANE = makePaneKey('tab-0', '00000000-0000-4000-8000-000000000000')
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

class IdentityTestServer extends AgentHookServer {
  readonly identityClient = new InProcessAgentIdentityClient()

  protected override createAgentIdentityClient(): AgentIdentityClient {
    return this.identityClient
  }
}

function hook(sessionId: string, transcriptPath?: string, paneKey = PANE) {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
        prompt: 'task'
      },
      { paneKey, tabId: 'tab-0' }
    ),
    'production'
  )
  if (!event) {
    throw new Error('hook was rejected')
  }
  return event
}

async function started(): Promise<IdentityTestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-transcript-source-'))
  const server = new IdentityTestServer()
  cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }))
  cleanups.unshift(() => server.stop())
  await server.start({ env: 'production', userDataPath: dir })
  return server
}

const answered = () => new Promise((resolve) => setImmediate(resolve))

it('reads a terminal agent by its own conversation, never by the pane it was attributed to', async () => {
  const server = await started()
  server.ingestRemote(hook('session-a', '/home/u/.claude/projects/p/a.jsonl'), WSL)
  await answered()
  const first = server.getStatusSnapshot()[0]?.orcaSessionId
  // Another agent's hooks land on the same pane, as in the split-pane misattribution.
  server.ingestRemote(hook('session-b', '/home/u/.claude/projects/p/b.jsonl'), WSL)
  await answered()
  const second = server.getStatusSnapshot()[0]?.orcaSessionId
  expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(second).not.toBe(first)

  expect(await server.terminalAgentTranscriptSource(second!, () => ({}))).toMatchObject({
    key: { wslDistro: 'Ubuntu', agent: 'claude', providerSessionId: 'session-b' },
    providerSession: { id: 'session-b', transcriptPath: '/home/u/.claude/projects/p/b.jsonl' }
  })
  // The first conversation's pane now shows the second: it has no transcript location, not b's.
  expect(await server.terminalAgentTranscriptSource(first!, () => ({}))).toBeNull()
  expect(await server.terminalAgentIdsOfProviderSession('session-a')).toEqual([first])
})
