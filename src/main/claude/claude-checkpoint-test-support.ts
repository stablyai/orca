import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import {
  createDeferredStructuredAgentSessionEventSink,
  type StructuredAgentSessionEventTarget,
  type StructuredAgentSessionSinkWatermarks
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const journals = createTrackedJournalOpener()
const roots: string[] = []
export async function closeCheckpointTestJournals() {
  vi.useRealTimers()
  await journals.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
}

export async function checkpointJournalRig(
  options: {
    watermarks?: Partial<StructuredAgentSessionSinkWatermarks>
    unbound?: boolean
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-pr35462-checkpoint-'))
  roots.push(root)
  const journal = await journals.open({
    stateDirectory: root,
    identity: {
      sessionId: 'recovery',
      workspaceId: 'workspace',
      hostId: 'local',
      agent: 'claude',
      providerHandle: null
    }
  })
  const deferred = createDeferredStructuredAgentSessionEventSink({
    ...testEventSinkLogging('recovery'),
    watermarks: options.watermarks
  })
  const publish: Mock<StructuredAgentSessionEventTarget['publish']> =
    vi.fn<StructuredAgentSessionEventTarget['publish']>()
  const bind = () => deferred.bind({ journal, fence: 1, publish })
  if (!options.unbound) {
    bind()
  }
  const translator = createClaudeJournalTranslator({ sink: deferred.sink })
  let serial = 0
  const message = (message: Record<string, unknown>) =>
    translator.handle({
      type: 'message',
      sessionId: 'recovery',
      observedAt: Date.now(),
      message: {
        session_id: 'claude-session',
        parent_tool_use_id: null,
        uuid: `frame-${serial++}`,
        ...message
      }
    })
  const stream = (event: Record<string, unknown>) => message({ type: 'stream_event', event })
  return {
    root,
    journal,
    deferred,
    translator,
    message,
    stream,
    bind,
    publish,
    reopen: () =>
      journals.open({
        stateDirectory: root,
        identity: {
          sessionId: 'recovery',
          workspaceId: 'workspace',
          hostId: 'local',
          agent: 'claude',
          providerHandle: null
        }
      })
  }
}
