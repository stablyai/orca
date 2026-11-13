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

function hook(sessionId: string, transcriptPath: string) {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        transcript_path: transcriptPath,
        prompt: 'task'
      },
      { paneKey: PANE, tabId: 'tab-0' }
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
  expect(first).toMatch(/^claude_/)
  expect(second).toMatch(/^claude_/)
  expect(second).not.toBe(first)

  expect(await server.terminalAgentTranscriptSource(second!, () => ({}))).toMatchObject({
    key: { wslDistro: 'Ubuntu', agent: 'claude', providerSessionId: 'session-b' },
    providerSession: { id: 'session-b', transcriptPath: '/home/u/.claude/projects/p/b.jsonl' }
  })
  // The first conversation's pane now shows the second: it has no transcript location, not b's.
  expect(await server.terminalAgentTranscriptSource(first!, () => ({}))).toBeNull()
  expect(await server.terminalAgentIdsOfProviderSession('session-a')).toEqual([first])
})

it.skipIf(process.platform === 'win32')(
  "finds a dormant agent's transcript only through a sleeping record naming its conversation",
  async () => {
    const server = await started()
    server.ingestRemote(hook('session-a', '/home/u/.claude/projects/p/a.jsonl'), WSL)
    await answered()
    const id = server.getStatusSnapshot()[0]?.orcaSessionId
    server.dropStatusEntry(PANE, { preserveResumeIdentity: false })
    const sleeping = (sessionId: string) => ({
      agent: 'claude' as const,
      providerSession: {
        key: 'session_id' as const,
        id: sessionId,
        transcriptPath: `/home/u/.claude/projects/p/${sessionId}.jsonl`
      },
      connectionId: WSL
    })

    expect(
      await server.terminalAgentTranscriptSource(id!, () => ({ other: sleeping('other') }))
    ).toBeNull()
    let partitionReads = 0
    const records = () => {
      partitionReads++
      return { other: sleeping('other'), a: sleeping('session-a') }
    }
    server.identityClient.providerKeyRequests = 0
    const found = await server.terminalAgentTranscriptSource(id!, records)
    expect(found).toMatchObject({
      key: { wslDistro: 'Ubuntu', providerSessionId: 'session-a' },
      providerSession: { transcriptPath: '/home/u/.claude/projects/p/session-a.jsonl' }
    })
    // The post-read recheck reuses the key it was given: one partition read, no store question.
    expect(await server.terminalAgentTranscriptSource(id!, records, found!.key)).toEqual(found)
    expect(server.identityClient.providerKeyRequests).toBe(1)
    expect(partitionReads).toBe(2)
  }
)
