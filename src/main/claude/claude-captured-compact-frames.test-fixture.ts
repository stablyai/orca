// Claude Code 2.1.283 (SDK 0.3.251) stream-json captures of `/compact`, driven through `query()` with
// streaming input and cut to the protocol fields Orca reads. The session id and the summary text
// are replaced, and every frame carried `session_id: CAPTURED_COMPACT_SESSION_ID`; frame order,
// uuids and the relative clock (`at`, ms) are the captured ones.
//
// Verified from these frames: a finished and a stopped `/compact` both end in a `success` result
// with no `terminal_reason`, naming the command's input in `user_message_uuid`. Only the finished
// one carries a `compact_boundary`; the stopped one answers with a synthetic "Compaction canceled."
// instead. `command_lifecycle` frames bracket every input.

export type CapturedCompactEvent =
  | { at: number; sent: { text: string; uuid: string } }
  | { at: number; interrupt: true }
  | { at: number; frame: Record<string, unknown> }

export const CAPTURED_COMPACT_SESSION_ID = '00000000-0000-4000-8000-000000000001'

const lifecycle = (commandUuid: string, state: string) => ({
  type: 'command_lifecycle',
  command_uuid: commandUuid,
  state
})

/** A `/compact` left to finish, from its send to its result. */
export const CAPTURED_COMPACT_SUCCEEDS: CapturedCompactEvent[] = [
  { at: 1750, sent: { text: '/compact', uuid: '563c9bb2-241a-4946-a35b-0f9088fd05de' } },
  { at: 1751, frame: lifecycle('968b34fc-76cc-41bc-adfc-34f8840637a0', 'completed') },
  { at: 1753, frame: lifecycle('563c9bb2-241a-4946-a35b-0f9088fd05de', 'queued') },
  { at: 1753, frame: lifecycle('563c9bb2-241a-4946-a35b-0f9088fd05de', 'started') },
  {
    at: 1757,
    frame: {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      uuid: 'de45cbf4-0f29-4ad7-a2a4-f9d9d8847f88'
    }
  },
  {
    at: 6602,
    frame: {
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'success',
      uuid: 'c9cd62b1-02d9-48fc-bb07-1ccb4889c0af'
    }
  },
  {
    at: 6608,
    frame: {
      type: 'system',
      subtype: 'init',
      uuid: '9cebf016-94d0-43d5-a23b-acbd606efeae',
      model: 'claude-opus-5-5[1m]'
    }
  },
  {
    at: 6609,
    frame: {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'manual',
        pre_tokens: 13576,
        post_tokens: 1011,
        cumulative_dropped_tokens: 12565,
        duration_ms: 4711
      },
      uuid: '1ed30bd1-8113-4c3d-b4ef-8020a2f80bfe'
    }
  },
  {
    at: 6609,
    frame: {
      type: 'user',
      parent_tool_use_id: null,
      isReplay: false,
      isSynthetic: true,
      uuid: '4fa68de9-8e28-40d1-a332-da8dba6edd14',
      message: {
        role: 'user',
        content:
          'This session is being continued from a previous conversation that ran out of context. [summary scrubbed]'
      }
    }
  },
  {
    at: 6609,
    frame: {
      type: 'user',
      parent_tool_use_id: null,
      isReplay: true,
      uuid: '302b225c-05fd-45a5-ac2d-0435f9b50845',
      message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' }
    }
  },
  {
    at: 6609,
    frame: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      user_message_uuid: '563c9bb2-241a-4946-a35b-0f9088fd05de',
      uuid: 'd4c86a55-621b-40ae-9f26-612c842d3ca2'
    }
  }
]

/** A `/compact` interrupted 1.5 s in, then the next send and its own answer. */
export const CAPTURED_COMPACT_STOPPED_THEN_SEND: CapturedCompactEvent[] = [
  { at: 9663, sent: { text: '/compact', uuid: 'a4e04ce1-37ad-4d40-aaf8-e03a1bbbbc7d' } },
  { at: 9664, frame: lifecycle('0be27e6d-49b7-4ee8-a784-744b3fb3b55c', 'completed') },
  { at: 9664, frame: lifecycle('a4e04ce1-37ad-4d40-aaf8-e03a1bbbbc7d', 'queued') },
  { at: 9665, frame: lifecycle('a4e04ce1-37ad-4d40-aaf8-e03a1bbbbc7d', 'started') },
  {
    at: 9666,
    frame: {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      uuid: 'c85f1131-b4a5-424e-af6a-85e8bd98b2fc'
    }
  },
  { at: 11166, interrupt: true },
  {
    at: 11168,
    frame: {
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'failed',
      compact_error: 'API Error: Request was aborted.',
      uuid: '7fede6b2-afdf-4455-8c69-096ae3fa6f55'
    }
  },
  {
    at: 11170,
    frame: {
      type: 'system',
      subtype: 'init',
      uuid: '067d1daa-f0da-4ca0-a9de-bedaa72c606a',
      model: 'claude-opus-5-5[1m]'
    }
  },
  {
    at: 11170,
    frame: {
      type: 'assistant',
      parent_tool_use_id: null,
      uuid: '0d252793-d95f-4c80-b4a1-7309614b7eeb',
      message: {
        id: '9c14e2f0-6480-4760-92f8-aa73e461bc47',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'Compaction canceled.' }]
      }
    }
  },
  {
    at: 11170,
    frame: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      user_message_uuid: 'a4e04ce1-37ad-4d40-aaf8-e03a1bbbbc7d',
      uuid: '523a8c1d-5054-422e-b81e-f5f350d992fd'
    }
  },
  {
    at: 11170,
    sent: {
      text: 'Reply with the single word AFTERSTOP.',
      uuid: '4178c081-0d9e-414f-a861-ea156efa1e7e'
    }
  },
  { at: 11170, frame: lifecycle('a4e04ce1-37ad-4d40-aaf8-e03a1bbbbc7d', 'cancelled') },
  { at: 11171, frame: lifecycle('4178c081-0d9e-414f-a861-ea156efa1e7e', 'queued') },
  { at: 11171, frame: lifecycle('4178c081-0d9e-414f-a861-ea156efa1e7e', 'started') },
  {
    at: 11200,
    frame: {
      type: 'system',
      subtype: 'init',
      uuid: '1eedc4e5-d48c-4682-b593-144466641d13',
      model: 'claude-opus-5-5[1m]'
    }
  },
  {
    at: 12778,
    frame: {
      type: 'assistant',
      user_message_uuid: '4178c081-0d9e-414f-a861-ea156efa1e7e',
      parent_tool_use_id: null,
      uuid: '39969651-5abd-4dba-ae80-ab1299c07a47',
      message: {
        id: 'msg_011CfUXeXFfvAtj1PLLjB1H4',
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'AFTERSTOP' }]
      }
    }
  },
  {
    at: 12844,
    frame: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      result: 'AFTERSTOP',
      user_message_uuid: '4178c081-0d9e-414f-a861-ea156efa1e7e',
      uuid: 'd9b4faaa-f9be-4d7b-9f81-a5106bd003f3'
    }
  },
  { at: 12844, frame: lifecycle('4178c081-0d9e-414f-a861-ea156efa1e7e', 'completed') }
]
