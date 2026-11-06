// Older desktop/mobile clients pair results by position, so every finished call needs output.

import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { pairToolBlocks } from '../../../../shared/native-chat/tools/native-chat-tool-pairs'
import { pairNativeChatToolResults } from '../../../../shared/native-chat/tools/native-chat-tool-pairing'
import { projectNativeChatTranscript } from '../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type {
  NativeChatBlock,
  NativeChatMessage
} from '../../../../shared/native-chat/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../../../shared/agent-session/view/structured-agent-session-message-projection'
import {
  collab,
  HELPER,
  HELPER_TURN,
  item,
  PARENT_TURN,
  publishedRows,
  shell,
  spawn,
  turn,
  waitStarted
} from './codex-collab-call-frames-fixture'
import { THREAD_ID } from '../session-lifecycle/codex-structured-session-adapter-fixture'

type PairedOutput = [call: string, output: string | undefined]

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
})
