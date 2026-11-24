import { describe, expect, it } from 'vitest'
import type { AgentSessionBackgroundTaskState } from '../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import type { AgentSessionSubscribeEvent } from '../../../../../../shared/agent-session/agent-session-wire'
import { AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY } from '../../../../../../shared/agent-session/background-tasks/agent-session-background-task-child-views-capability'
import {
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY
} from '../../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import { projectBackgroundTaskEvent } from './structured-agent-session-background-task-capability'

const state: AgentSessionBackgroundTaskState = {
  state: 'monitoring',
  supportsTaskStop: true,
  tasks: [{ id: 'cmd', kind: 'command', description: 'make' }],
  children: [],
  commandDetailsAvailable: [{ childWorkId: 'cmd', invocationId: 'run', generation: 1 }]
}

const event = {
  type: 'batch',
  sessionId: 's',
  backgroundTasks: state
} as AgentSessionSubscribeEvent

function projected(ctx: object) {
  const result = projectBackgroundTaskEvent(event, ctx as never)
  return result.type === 'end' ? undefined : result.backgroundTasks
}

const rowStops = [
  AGENT_SESSION_BACKGROUND_TASK_STOP_CAPABILITY,
  AGENT_SESSION_BACKGROUND_TASK_ROW_STOP_CAPABILITY
]

describe('final-emit audience projection of exact-command availability', () => {
  it('keeps the list for local and paired desktops that read child views', () => {
    expect(projected({ clientKind: undefined })).toHaveProperty('commandDetailsAvailable')
    expect(
      projected({
        clientKind: 'runtime',
        clientCapabilities: [...rowStops, AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY]
      })
    ).toHaveProperty('commandDetailsAvailable')
  })

  it('strips it for every phone, including one that reads child views, and for legacy readers', () => {
    for (const ctx of [
      {
        clientKind: 'mobile',
        clientCapabilities: [...rowStops, AGENT_SESSION_BACKGROUND_TASK_CHILD_VIEWS_CAPABILITY]
      },
      { clientKind: 'mobile', clientCapabilities: rowStops },
      { clientKind: 'runtime', clientCapabilities: rowStops }
    ]) {
      const result = projected(ctx)
      expect(result).toBeTruthy()
      expect(result).not.toHaveProperty('commandDetailsAvailable')
    }
  })
})
