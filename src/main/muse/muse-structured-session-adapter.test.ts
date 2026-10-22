// End to end over a real `muse serve --provider echo` child with an isolated
// home: acquire, open, dispatch a text turn through completion, stop. No model
// calls and no account touch the machine's own Muse setup.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { beforeAll, describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { MuseStructuredSessionAdapter } from './muse-structured-session-adapter'

function hasMuseBinary(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('muse', ['--version'], { timeout: 15000 }, (error) => resolve(!error))
  })
}

function fakeSink() {
  const rows = new Map<string, AgentJournalItemBody>()
  const key = (identity: AgentJournalItemIdentity): string => agentJournalItemKey(identity)
  const sink = {
    tryAppendItem: (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
      rows.set(key(identity), body)
      return { accepted: true as const }
    },
    tryReviseResolvedItem: (
      _bytes: number,
      resolve: (journal: {
        itemBody: (itemKey: string) => AgentJournalItemBody | null
      }) => { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null
    ) => {
      const out = resolve({ itemBody: (itemKey: string) => rows.get(itemKey) ?? null })
      if (out) {
        rows.set(key(out.identity), out.body)
      }
      return { accepted: true as const }
    },
    publish: () => undefined
  } as unknown as StructuredAgentSessionEventSink
  return { sink, rows }
}

const describeIfMuse = (await hasMuseBinary()) ? describe : describe.skip

describeIfMuse('MuseStructuredSessionAdapter over echo serve', () => {
  let home = ''
  let workdir = ''

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'msp-adapter-home-'))
    workdir = mkdtempSync(join(tmpdir(), 'msp-adapter-ws-'))
  })

  it('acquires, dispatches, completes, and closes', async () => {
    const { sink, rows } = fakeSink()
    const ended: string[] = []
    const adapter = new MuseStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'muse',
        args: ['serve', '--provider', 'echo', '--no-session-log'],
        cwd: workdir,
        env: { ...process.env, HOME: home } as Record<string, string>,
        resumeSessionId: null
      }),
      logger: { warn: () => undefined, error: () => undefined },
      onLifecycle: (event) => {
        if (event.type === 'ended') {
          ended.push(event.sessionId)
        }
      }
    })
    const sessionId = 'adapter-e2e-1'
    const acquisition = await adapter.acquire({
      identity: {
        sessionId,
        workspaceId: 'ws-1',
        hostId: 'local',
        agent: 'muse',
        providerHandle: null
      },
      fence: 1,
      spawnToken: 'token-1',
      events: sink
    })
    expect(acquisition.process.pid).toBeGreaterThan(0)
    try {
      const opened = await adapter.open({
        sessionId,
        fence: 1,
        acquisitionGeneration: acquisition.acquisitionGeneration,
        signal: new AbortController().signal
      })
      expect(opened.reportedOptions).toBeDefined()
      const outcome = await adapter.dispatch({
        sessionId,
        clientMessageId: 'send-1',
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'say hi' }] },
        fence: 1,
        signal: new AbortController().signal
      })
      expect(outcome.state).toBe('accepted')
      const turnKey = `muse:${sessionId}:turn`
      for (
        let i = 0;
        i < 200 &&
        ![...rows.values()].some((row) => row.kind === 'turn' && row.state === 'completed');
        i += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      const keys = [...rows.keys()].filter((key) => key.startsWith(turnKey))
      expect(keys.length).toBeGreaterThan(0)
      const completed = [...rows.values()].find(
        (row) => row.kind === 'turn' && row.state === 'completed'
      )
      expect(completed).toBeDefined()
      const assistant = [...rows.values()].find(
        (row) => row.kind === 'message' && row.role === 'assistant' && row.state === 'completed'
      )
      expect(assistant).toBeDefined()
      const user = [...rows.values()].find((row) => row.kind === 'message' && row.role === 'user')
      expect(user).toBeDefined()
    } finally {
      expect(await adapter.closeSession(sessionId)).toBe(true)
    }
    expect(ended).toContain(sessionId)
  }, 60000)
})
