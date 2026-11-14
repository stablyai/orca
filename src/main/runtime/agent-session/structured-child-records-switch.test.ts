import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeStructuredAgentStatusSubject } from '../../../shared/agent-status/contracts/agent-status-subject'
import { HOST_TEST_SESSION as SESSION } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { AgentHookServer } from '../../agent-hooks/server/agent-hook-server'
import { stopStructuredAgentSessionRuntime } from './structured-agent-session-runtime'
import { createScriptedClaudeRuntime } from './installation/structured-claude-scripted-runtime-test-support'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

describe('Claude background-work restart offers through hook shutdown', () => {
  let claude = createScriptedClaudeRuntime([SESSION])
  let server = new AgentHookServer()

  beforeEach(() => {
    claude = createScriptedClaudeRuntime([SESSION])
    server = new AgentHookServer()
  })

  afterEach(async () => {
    await claude.dispose()
    server.stop()
  })

  it.each([
    { trigger: 'quit', kind: 'agent', settled: false },
    { trigger: 'quit', kind: 'command', settled: false },
    { trigger: 'quit', kind: 'command', settled: true }
  ] as const)(
    '$trigger with a background $kind (settled: $settled)',
    async ({ trigger, kind, settled }) => {
      const host = await claude.install()
      host.deps.statusSink = {
        publish: (summary, subject) => server.ingestStructuredStatus(summary, subject),
        forget: (subject) => server.dropStructuredStatus(subject),
        publishChildWork: (subject, evidence, provider) =>
          server.ingestStructuredChildWork(subject, evidence, provider),
        readChildWork: (subject) => server.getStructuredChildWorkViews(subject)
      }
      const params = claude.attachParams(SESSION, null)
      expect(await host.attach({ callerKey: 'restart-test' }, params)).toMatchObject({ ok: true })
      if (params.providerHandle?.kind !== 'claude') {
        throw new Error('missing Claude provider handle')
      }
      const providerSession = params.providerHandle.sessionId
      const message = claude.child(SESSION).handlers.onMessage
      message?.({
        type: 'assistant',
        uuid: 'lead-assistant',
        session_id: providerSession,
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Finished the foreground reply' }]
        }
      })
      message?.({
        type: 'system',
        subtype: 'task_started',
        uuid: 'background-start',
        session_id: providerSession,
        task_id: 'background-1',
        tool_use_id: 'spawn-1',
        task_type: kind === 'agent' ? 'local_agent' : 'local_bash',
        description: 'Audit the build',
        is_backgrounded: true
      })
      if (settled) {
        message?.({
          type: 'system',
          subtype: 'task_notification',
          uuid: 'background-end',
          session_id: providerSession,
          task_id: 'background-1',
          tool_use_id: 'spawn-1',
          status: 'completed'
        })
      }
      message?.({
        type: 'result',
        subtype: 'success',
        uuid: 'lead-result',
        session_id: providerSession,
        result: 'Finished the foreground reply',
        is_error: false
      })
      await host.flushStreamedEvents(SESSION)
      await vi.waitFor(() =>
        expect(server.getStatusSnapshot().find((entry) => entry.structuredHost)).toMatchObject({
          state: settled ? 'done' : 'working',
          mainAgent: { state: 'done' }
        })
      )
      const stopping = stopStructuredAgentSessionRuntime({ trigger })
      server.stop({ keepStatus: true })
      await stopping
      expect(
        server
          .getStructuredChildWorkViews(makeStructuredAgentStatusSubject(params.location, SESSION))
          .filter((child) => child.state !== 'done')
      ).toEqual([])
      const activity = { state: 'done', prompts: [], tasks: [{ kind, label: 'Audit the build' }] }
      const markers = await host.deps.recoveryCapsule?.list(Date.now())
      const restarted = await claude.install()
      const candidates = await restarted.restartResume.list()
      if (settled) {
        expect(markers).toEqual([])
        expect(candidates).toEqual([])
      } else {
        expect(markers).toMatchObject([{ sessionId: SESSION, trigger, activity }])
        expect(candidates).toMatchObject([
          { sessionId: SESSION, agent: 'claude', trigger, activity }
        ])
      }
    }
  )
})
