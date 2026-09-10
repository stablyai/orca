import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import { OrchestrationNestedAgentActivityListSchema } from '../../../shared/orchestration-nested-agent-activity'
import {
  projectNestedAgentActivities,
  readExactWorkerProviderObservation,
  selectExactWorkerProviderSession
} from './worker-provider-session'

function status(
  paneKey: string,
  sessionId: string,
  overrides: Partial<AgentStatusIpcPayload> = {}
): AgentStatusIpcPayload {
  return {
    paneKey,
    connectionId: null,
    receivedAt: 200,
    stateStartedAt: 190,
    state: 'working',
    prompt: '',
    agentType: 'codex',
    providerSession: { key: 'session_id', id: sessionId },
    ...overrides
  }
}

describe('exact worker provider session selection', () => {
  it('selects only the current pane, connection, and observation window', () => {
    const selected = selectExactWorkerProviderSession({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:incarnation',
      connectionId: 'ssh-windows',
      launchToken: undefined,
      observedAfter: 150,
      statuses: [
        status('tab:sibling', 'sibling', { connectionId: 'ssh-windows', receivedAt: 300 }),
        status('tab:worker', 'old', { connectionId: 'ssh-windows', receivedAt: 100 }),
        status('tab:worker', 'wrong-host', { connectionId: 'ssh-mac', receivedAt: 400 }),
        status('tab:worker', 'exact', { connectionId: 'ssh-windows', receivedAt: 250 })
      ]
    })

    expect(selected).toEqual({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:incarnation',
      connectionId: 'ssh-windows',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'exact' },
      observedAt: 250,
      statusObservedAt: 250,
      subagents: []
    })
  })

  it('rejects stale and provider-session-only rows', () => {
    expect(
      selectExactWorkerProviderSession({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:incarnation',
        connectionId: null,
        launchToken: undefined,
        observedAfter: 300,
        statuses: [
          status('tab:worker', 'stale', { receivedAt: 200 }),
          status('tab:worker', 'identity-only', {
            receivedAt: 400,
            providerSessionOnly: true
          })
        ]
      })
    ).toBeNull()
  })

  it('rejects a prior process snapshot when the launch token changed', () => {
    expect(
      selectExactWorkerProviderSession({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:new-incarnation',
        connectionId: null,
        launchToken: 'launch-new',
        observedAfter: 0,
        statuses: [status('tab:worker', 'prior', { launchToken: 'launch-old' })]
      })
    ).toBeNull()
  })

  it('accepts the matching WSL relay provenance for a local PTY', () => {
    const selected = selectExactWorkerProviderSession({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:wsl-incarnation',
      connectionId: null,
      wslDistro: 'Ubuntu',
      launchToken: undefined,
      observedAfter: 150,
      statuses: [
        status('tab:worker', 'wsl-session', {
          connectionId: 'wsl:Ubuntu',
          receivedAt: 250,
          providerSession: {
            key: 'session_id',
            id: 'wsl-session',
            transcriptPath: '/home/ada/.codex/sessions/rollout-wsl.jsonl'
          }
        })
      ]
    })

    expect(selected).toMatchObject({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:wsl-incarnation',
      connectionId: 'wsl:Ubuntu',
      wslDistro: 'Ubuntu',
      providerSession: { id: 'wsl-session' }
    })
    expect(Object.keys(selected ?? {})).toContain('connectionId')
    expect(JSON.stringify(selected)).toContain('wsl:Ubuntu')
  })

  it('rejects WSL relay provenance for a different local distro', () => {
    expect(
      selectExactWorkerProviderSession({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:wsl-incarnation',
        connectionId: null,
        wslDistro: 'Ubuntu',
        launchToken: undefined,
        observedAfter: 150,
        statuses: [status('tab:worker', 'wrong-distro', { connectionId: 'wsl:Debian' })]
      })
    ).toBeNull()
  })

  it('carries runtime-issued actor lineage and projects bounded parent-owned children', () => {
    const selected = selectExactWorkerProviderSession({
      paneKey: 'tab:worker',
      processIncarnation: 'pty:incarnation',
      connectionId: null,
      launchToken: undefined,
      observedAfter: 150,
      statuses: [
        status('tab:worker', 'exact', {
          receivedAt: 250,
          actorAttestation: {
            authorityId: 'agent-hook-main:test',
            incarnation: 1,
            revision: 7,
            observedAt: 250,
            provider: 'codex',
            role: 'lead',
            eventName: 'PreToolUse',
            providerSessionId: 'exact',
            toolUseId: 'tool-7'
          },
          subagents: [
            {
              id: 'child-1',
              agentType: 'reviewer',
              model: 'gpt-5',
              description: 'Reviews settlement boundaries.',
              state: 'working',
              startedAt: 200
            }
          ]
        })
      ]
    })

    expect(readExactWorkerProviderObservation(selected)).toMatchObject({
      actorAttestation: { role: 'lead', eventName: 'PreToolUse' },
      subagents: [{ id: 'child-1', state: 'working' }]
    })
    const activities = projectNestedAgentActivities({
      dispatchId: 'ctx-parent',
      session: selected!
    })
    expect(OrchestrationNestedAgentActivityListSchema.parse(activities)).toEqual(activities)
    expect(activities).toEqual([
      expect.objectContaining({
        parent_dispatch_id: 'ctx-parent',
        parent_provider_session_id: 'exact',
        provider_child_id: 'child-1',
        provider: 'codex',
        type: 'reviewer',
        state: 'running'
      })
    ])
  })

  it('does not invent actor authority for legacy exact-session values', () => {
    expect(
      readExactWorkerProviderObservation({
        paneKey: 'tab:worker',
        processIncarnation: 'pty:incarnation',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'legacy' },
        observedAt: 250
      })
    ).toBeNull()
  })
})
