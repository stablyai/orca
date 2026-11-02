import {
  AgentStatusObservedPaneIdentities,
  AgentStatusObservedPaneIdentityCapture
} from '../runtime/agent-status-observed-pane-identity'
import { OPEN_CODE_WRITER_TOPOLOGY } from './server/cli-writer-observation'
import { toAgentStatusIpcPayload } from './server/server-status-identity'
import { buildRelayHookEnvelope } from '../../wsl-guest/agent-hook-envelope-build'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: async () => 'unverifiable'
}))

class WriterObservationTestServer extends AgentHookServer {
  persistedWriterState(): string {
    return this.serializeStatusFile()
  }
}

const servers: AgentHookServer[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
})

async function createServer(): Promise<WriterObservationTestServer> {
  const server = new WriterObservationTestServer()
  servers.push(server)
  await server.start({ env: 'production' })
  return server
}

describe('OpenCode writer observation', () => {
  it('retains OpenCode execution evidence through inference and repaint, never replacement', async () => {
    const server = await createServer()
    const identities = new AgentStatusObservedPaneIdentities()
    const capture = new AgentStatusObservedPaneIdentityCapture(identities)
    let incarnation = 'execution-a'
    const runtime = {
      getAgentStatusTerminalHandleForPaneKey: () => 'terminal-a',
      getTerminalProcessIncarnation: () => incarnation,
      getAgentStatusOrchestrationContextForPaneKey: () => undefined
    }
    server.subscribeEnrichedStatus((row) => capture.observe(row))
    const row = () => {
      const value = server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)
      if (!value) {
        throw new Error('Missing OpenCode row')
      }
      return value
    }
    const observation = () => server.readCliWriterObservation(row())
    const post = async (extra: Record<string, unknown> = { opencodeMajor: 2 }) => {
      expect(
        (
          await postHookEvent(
            server,
            {
              ...buildBody({
                hook_event_name: 'SessionBusy',
                sessionID: 'open-code-conversation',
                prompt: 'task'
              }),
              ...extra
            },
            '/hook/opencode2'
          )
        ).status
      ).toBe(204)
    }
    await post()
    capture.attach(runtime)
    server.setCliWriterExecutionMatcher(identities, runtime)
    expect(observation()?.topology).toBe('unverifiable')
    await post()
    const interrupt = () => {
      const value = row()
      expect(
        server.inferInterrupt({
          paneKey: PANE,
          baselineUpdatedAt: value.receivedAt,
          baselineStateStartedAt: value.stateStartedAt,
          baselinePrompt: value.prompt,
          baselineAgentType: value.agentType,
          intent: 'ctrl-c'
        })
      ).toBe(true)
    }
    interrupt()
    expect(observation()?.topology).toBe('pane-owned')
    const repaint = (origin?: 'process') =>
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        terminalHandle: 'terminal-a',
        origin,
        payload: { state: 'done', prompt: 'changed repaint', agentType: 'opencode2' }
      })
    repaint()
    expect(observation()?.topology).toBe('pane-owned')
    const binding = row().providerSession
    expect(binding && OPEN_CODE_WRITER_TOPOLOGY in binding).toBe(true)
    const snapshot = row()
    const event = {
      ...snapshot,
      restoredUnconfirmed: snapshot.restoredUnconfirmed ? (true as const) : undefined,
      payload: { state: 'done' as const, prompt: '', agentType: 'opencode2' }
    }
    for (const value of [
      event,
      toAgentStatusIpcPayload(event),
      buildRelayHookEnvelope(event, 'opencode2')
    ]) {
      expect(JSON.stringify(value)).not.toContain('pane-owned')
      expect(Object.getOwnPropertySymbols(structuredClone(value).providerSession ?? {})).toEqual([])
    }
    expect(server.persistedWriterState()).not.toContain('pane-owned')
    for (const extra of [{}, { opencodeSharedServer: 1 }]) {
      await post(extra)
      expect(observation()?.topology).not.toBe('pane-owned')
    }
    await post()
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      origin: 'process',
      payload: { state: 'working', prompt: 'task', agentType: 'opencode2' }
    })
    expect(observation()?.topology).toBe('unverifiable')
    await post()
    incarnation = 'execution-b'
    interrupt()
    expect(identities.read(PANE)).toMatchObject({ processIncarnation: 'execution-b' })
    expect(observation()?.topology).toBe('unverifiable')
    repaint()
    expect(observation()?.topology).toBe('unverifiable')
  })
})
