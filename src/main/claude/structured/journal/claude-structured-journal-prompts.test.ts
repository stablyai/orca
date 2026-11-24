import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { readTestJournalItems } from '../../../native-chat/agent-session-journal/journal-observation.test-support'
import { createTrackedJournalOpener } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { testEventSinkLogging } from '../../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger.test-fixture'
import { ClaudeJournalBoundDelivery } from './claude-journal-bound-delivery'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const SESSION = 'session-claude-hook-answered'
const journals = createTrackedJournalOpener({ legacyInputs: true })
let root: string | undefined

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

// Claude Code with `--permission-prompt-tool stdio` asks Orca and runs PermissionRequest hooks at
// once; when a hook answers first it withdraws Orca's request, then reports the call's result.
it('reads a withdrawn approval as allowed only when its call then succeeds', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-hook-answered-'))
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'claude',
      providerHandle: claudeProviderHandle('provider-session-1', null)
    } satisfies AgentSessionJournalIdentity,
    stateDirectory: root,
    now: () => 1_700_000_000_000
  })
  const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
  deferred.bind({ journal, fence: 1, publish: () => {} })
  const translator = createClaudeJournalTranslator({
    sink: deferred.sink,
    // The host loads the journal's saved facts before delivery; this journal starts empty.
    delivery: new ClaudeJournalBoundDelivery()
  })
  const hookAnswered = (toolName: string, toolUseId: string, result: string, isError: boolean) => {
    translator.handle({
      type: 'prompt',
      sessionId: SESSION,
      prompt: {
        requestId: `request-${toolUseId}`,
        promptKey: `prompt-${toolUseId}`,
        toolUseId,
        toolName,
        kind: 'approval',
        input: { file_path: '/repo/.claude/skills/demo/SKILL.md', content: 'hello' },
        suggestions: [],
        questionIds: [],
        settle: () => {}
      }
    })
    translator.handle({
      type: 'prompt-cancelled',
      sessionId: SESSION,
      promptKey: `prompt-${toolUseId}`
    })
    translator.handle({
      type: 'message',
      sessionId: SESSION,
      message: {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { tool_use_id: toolUseId, type: 'tool_result', content: result, is_error: isError }
          ]
        },
        parent_tool_use_id: null,
        session_id: 'provider-session-1',
        uuid: `user-${toolUseId}`
      }
    })
  }
  hookAnswered('Write', 'toolu_allowed', 'File created successfully', false)
  // A hook's denial reaches the stream as a failed call, like any other failure.
  hookAnswered('Edit', 'toolu_denied', 'blocked by test hook', true)
  await deferred.drained()
  deferred.close()

  const resolutions = Object.fromEntries(
    (await readTestJournalItems(journal)).flatMap((item) =>
      item.body.kind === 'approval' ? [[item.body.toolName, item.body.resolution]] : []
    )
  )
  expect(resolutions).toEqual({
    Write: {
      state: 'resolved',
      selectedOptionId: 'allow',
      resolvedBy: 'trusted-local:agent-permission-flow',
      resolvedAt: expect.any(Number)
    },
    Edit: { state: 'cancelled', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  })
})
