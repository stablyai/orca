import { describe, expect, it } from 'vitest'
import { agentStatusChangedPayloadSchema } from '../../shared/plugins/plugin-events'
import { projectPluginAgentStatusChangedPayload } from './plugin-agent-status-event'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function row(
  overrides: Partial<Parameters<typeof projectPluginAgentStatusChangedPayload>[0]> = {}
): Parameters<typeof projectPluginAgentStatusChangedPayload>[0] {
  return {
    paneKey: PANE,
    worktreeId: 'wt-1',
    receivedAt: 1_700_000_000_000,
    payload: { state: 'working', prompt: 'ship it', agentType: 'claude' },
    ...overrides
  }
}

describe('projectPluginAgentStatusChangedPayload', () => {
  it('publishes the main agent fact beside the combined state, and the schema admits it', () => {
    const projected = projectPluginAgentStatusChangedPayload(
      row({
        payload: {
          state: 'working',
          prompt: 'ship it',
          agentType: 'claude',
          mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 1_700_000_000_500 }
        }
      })
    )
    expect(projected).toEqual({
      worktreeId: 'wt-1',
      paneKey: PANE,
      state: 'working',
      receivedAt: 1_700_000_000_000,
      mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 1_700_000_000_500 }
    })
    // The bus validates before delivery; a field the schema strips never reaches a plugin.
    expect(agentStatusChangedPayloadSchema.parse(projected)).toEqual(projected)
  })

  it("leaves `mainAgent` absent for a row that carries none, so an old host's rows look as they did", () => {
    const projected = projectPluginAgentStatusChangedPayload(row())
    expect(projected).toEqual({
      worktreeId: 'wt-1',
      paneKey: PANE,
      state: 'working',
      receivedAt: 1_700_000_000_000
    })
    expect(projected).not.toHaveProperty('mainAgent')
  })

  it('projects a restored row to nothing, even when its main agent reads working', () => {
    expect(
      projectPluginAgentStatusChangedPayload(
        row({
          restoredUnconfirmed: true,
          payload: {
            state: 'working',
            prompt: 'ship it',
            agentType: 'claude',
            mainAgent: { state: 'working', stateStartedAt: 1 }
          }
        })
      )
    ).toBeNull()
  })

  it('keeps a missing worktree as null and never invents a verdict on a live main agent', () => {
    const projected = projectPluginAgentStatusChangedPayload(
      row({
        worktreeId: undefined,
        payload: {
          state: 'working',
          prompt: '',
          agentType: 'codex',
          mainAgent: { state: 'working', stateStartedAt: 7 }
        }
      })
    )
    expect(projected?.worktreeId).toBeNull()
    expect(projected?.mainAgent).toEqual({ state: 'working', stateStartedAt: 7 })
  })
})
