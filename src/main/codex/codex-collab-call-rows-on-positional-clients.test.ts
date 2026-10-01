// A client that predates result call ids (an older mobile app, or an older desktop reading a newer
// host) projects the journal itself and pairs each tool result with the oldest unanswered call.
// So every finished collab call row must carry an output, or each later output in its run is drawn
// under the call before its own.

import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { pairToolBlocks } from '../../shared/native-chat-tool-fold'
import { pairNativeChatToolResults } from '../../shared/native-chat-tool-pairing'
import { projectNativeChatTranscript } from '../../shared/native-chat-transcript-projection'
import type { NativeChatBlock, NativeChatMessage } from '../../shared/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../shared/structured-agent-session-message-projection'
import {
  collab,
  HELPER,
  HELPER_TURN,
  item,
  PARENT_TURN,
  PROMPT,
  publishedRows,
  shell,
  spawn,
  turn,
  waitStarted,
  type Frame
} from './codex-collab-call-frames-fixture'
import { THREAD_ID } from './codex-structured-session-adapter-fixture'

type PairedOutput = [call: string, output: string | undefined]

/** What a client without result call ids draws: each call with the output its pairing gives it. */
function positionalRuns(rows: AgentJournalRenderItem[]): {
  mobile: PairedOutput[][]
  desktop: PairedOutput[][]
} {
  const withoutCallIds = (message: NativeChatMessage): NativeChatMessage => ({
    ...message,
    blocks: message.blocks.map((block): NativeChatBlock => {
      if (block.type !== 'tool-result') {
        return block
      }
      const { callId: _callId, ...legacy } = block
      return legacy
    })
  })
  const transcript = projectNativeChatTranscript(
    projectStructuredAgentSessionMessages(rows, [], []).map(withoutCallIds)
  )
  // The conversation's runs, then each helper's section's.
  const runs = [
    ...transcript.conversation,
    ...[...transcript.subagentRows.values()].flat().map((row) => row.message)
  ].filter((message) => message.blocks.some((block) => block.type === 'tool-call'))
  return {
    mobile: runs.map((message) =>
      pairToolBlocks(message.blocks).map((pair): PairedOutput => [
        pair.call?.name ?? '(none)',
        pair.result?.output.trim()
      ])
    ),
    desktop: runs.map((message) => {
      const pairing = pairNativeChatToolResults(message.blocks)
      return message.blocks.flatMap((block): PairedOutput[] =>
        block.type === 'tool-call'
          ? [[block.name, pairing.resultByCall.get(block)?.output.trim()]]
          : []
      )
    })
  }
}

const outputOf = (rows: AgentJournalRenderItem[], name: string): AgentJournalItemBody | undefined =>
  rows.map((row) => row.body).find((body) => body.kind === 'tool-call' && body.name === name)

describe('Codex collab call rows on a client that pairs results by position', () => {
  it('draws each output under its own call through spawn, shell, wait and close', async () => {
    const rows = await publishedRows([
      turn('turn/started', THREAD_ID, PARENT_TURN),
      spawn('item/started'),
      spawn('item/completed'),
      turn('turn/started', HELPER, HELPER_TURN),
      shell('item/started', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE'),
      shell('item/completed', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE'),
      shell('item/started', HELPER, HELPER_TURN, 'call-helper-shell', 'CHILD_DONE'),
      shell('item/completed', HELPER, HELPER_TURN, 'call-helper-shell', 'CHILD_DONE'),
      item('item/completed', HELPER, HELPER_TURN, {
        type: 'agentMessage',
        id: 'msg-child',
        text: 'CHILD_REPLY'
      }),
      turn('turn/completed', HELPER, HELPER_TURN),
      waitStarted,
      collab('item/completed', {
        id: 'call-wait',
        tool: 'wait',
        status: 'completed',
        receiverThreadIds: [HELPER],
        agentsStates: { [HELPER]: { status: 'completed', message: 'CHILD_REPLY' } }
      }),
      collab('item/started', {
        id: 'call-close',
        tool: 'closeAgent',
        status: 'inProgress',
        receiverThreadIds: [HELPER]
      }),
      collab('item/completed', {
        id: 'call-close',
        tool: 'closeAgent',
        status: 'completed',
        receiverThreadIds: [HELPER],
        agentsStates: { [HELPER]: { status: 'completed', message: 'CHILD_REPLY' } }
      }),
      shell('item/started', THREAD_ID, PARENT_TURN, 'call-parent-shell-2', 'AFTER_CLOSE'),
      shell('item/completed', THREAD_ID, PARENT_TURN, 'call-parent-shell-2', 'AFTER_CLOSE')
    ])
    // The parent's calls are one run; the helper's own shell is in the helper's section.
    const runs = [
      [
        ['spawn_agent', 'Spawned'],
        ['shell', 'PARENT_DONE'],
        ['wait_agent', 'CHILD_REPLY'],
        ['close_agent', 'Closed'],
        ['shell', 'AFTER_CLOSE']
      ],
      [['shell', 'CHILD_DONE']]
    ]
    const { mobile, desktop } = positionalRuns(rows)
    expect(mobile).toEqual(runs)
    expect(desktop).toEqual(runs)
  })

  it('gives a wait that timed out an output, and keeps naming the helpers it waited on', async () => {
    const rows = await publishedRows([
      turn('turn/started', THREAD_ID, PARENT_TURN),
      spawn('item/completed'),
      turn('turn/started', HELPER, HELPER_TURN),
      waitStarted,
      // Codex ends a timed-out wait naming no receiver and no state.
      collab('item/completed', {
        id: 'call-wait',
        tool: 'wait',
        status: 'completed',
        receiverThreadIds: [],
        agentsStates: {}
      }),
      collab('item/started', {
        id: 'call-close',
        tool: 'closeAgent',
        status: 'inProgress',
        receiverThreadIds: [HELPER]
      }),
      collab('item/completed', {
        id: 'call-close',
        tool: 'closeAgent',
        status: 'completed',
        receiverThreadIds: [HELPER],
        agentsStates: { [HELPER]: { status: 'running', message: null } }
      }),
      shell('item/started', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE'),
      shell('item/completed', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE')
    ])
    expect(outputOf(rows, 'wait_agent')).toMatchObject({
      state: 'completed',
      input: { description: PROMPT, agents: [HELPER] }
    })
    const runs = [
      [
        ['spawn_agent', 'Spawned'],
        ['wait_agent', 'Finished waiting'],
        // Its snapshot says `running`: the status from before the close.
        ['close_agent', 'Closed'],
        ['shell', 'PARENT_DONE']
      ]
    ]
    const { mobile, desktop } = positionalRuns(rows)
    expect(mobile).toEqual(runs)
    expect(desktop).toEqual(runs)
  })

  it('gives every other finished call what it did or what it reports', async () => {
    const OTHER = '01a0ea72-0000-7000-8000-000000000002'
    const finished = (id: string, tool: string, fields: Record<string, unknown>): Frame[] => [
      collab('item/started', { id, tool, status: 'inProgress', receiverThreadIds: [HELPER] }),
      collab('item/completed', {
        id,
        tool,
        status: 'completed',
        receiverThreadIds: [HELPER],
        ...fields
      })
    ]
    const rows = await publishedRows([
      turn('turn/started', THREAD_ID, PARENT_TURN),
      spawn('item/completed'),
      turn('turn/started', HELPER, HELPER_TURN),
      // A spawn that created no thread names nothing.
      collab('item/completed', {
        id: 'call-spawn-failed',
        tool: 'spawnAgent',
        status: 'failed',
        receiverThreadIds: [],
        prompt: 'second helper'
      }),
      ...finished('call-send', 'sendInput', {
        prompt: 'keep going',
        agentsStates: { [HELPER]: { status: 'running', message: null } }
      }),
      ...finished('call-resume', 'resumeAgent', {
        agentsStates: { [HELPER]: { status: 'completed', message: 'OLD_REPLY' } }
      }),
      collab('item/started', {
        id: 'call-wait',
        tool: 'wait',
        status: 'inProgress',
        receiverThreadIds: [HELPER, OTHER]
      }),
      // A wait's end names only the helpers that finished; an errored one's message is its error.
      collab('item/completed', {
        id: 'call-wait',
        tool: 'wait',
        status: 'failed',
        receiverThreadIds: [OTHER],
        agentsStates: { [OTHER]: { status: 'errored', message: 'boom' } }
      }),
      shell('item/started', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE'),
      shell('item/completed', THREAD_ID, PARENT_TURN, 'call-parent-shell', 'PARENT_DONE')
    ])
    const runs = [
      [
        ['spawn_agent', 'Spawned'],
        ['spawn_agent', 'Agent spawn failed'],
        ['send_input', 'Sent input'],
        ['resume_agent', 'Completed - OLD_REPLY'],
        ['wait_agent', `${OTHER}: Error - boom`],
        ['shell', 'PARENT_DONE']
      ]
    ]
    const { mobile, desktop } = positionalRuns(rows)
    expect(mobile).toEqual(runs)
    expect(desktop).toEqual(runs)
    // The wait keeps naming both helpers it waited on.
    expect(outputOf(rows, 'wait_agent')).toMatchObject({ input: { agents: [HELPER, OTHER] } })
  })
})
