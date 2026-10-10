import type { CapturedCompactEvent } from './claude-captured-compact-frames.test-fixture'

/** Claude Code 2.1.295 auto-compacting ahead of a send (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=1`), cut
 *  like `claude-captured-compact-frames.test-fixture.ts`, without stream events. Every compaction
 *  frame lands before the send's echo, which is what opens its turn. */
export const CAPTURED_AUTO_COMPACT_BEFORE_ECHO: CapturedCompactEvent[] = [
  {
    at: 2294,
    sent: {
      text: 'Reply with exactly the word: three',
      uuid: '2142a8db-37fd-4fec-bb23-14fcba3ff6fd'
    }
  },
  {
    at: 2295,
    frame: {
      type: 'command_lifecycle',
      command_uuid: '4ddf482b-c5a3-407c-9791-c8b89e4fd1bc',
      state: 'completed'
    }
  },
  {
    at: 2296,
    frame: {
      type: 'command_lifecycle',
      command_uuid: '2142a8db-37fd-4fec-bb23-14fcba3ff6fd',
      state: 'queued'
    }
  },
  {
    at: 2297,
    frame: {
      type: 'command_lifecycle',
      command_uuid: '2142a8db-37fd-4fec-bb23-14fcba3ff6fd',
      state: 'started'
    }
  },
  {
    at: 2310,
    frame: {
      type: 'system',
      subtype: 'init',
      uuid: '0fc71141-64f4-464d-9a07-f148f0f33a38',
      model: 'claude-haiku-5-5'
    }
  },
  {
    at: 2312,
    frame: {
      type: 'system',
      subtype: 'status',
      status: 'requesting',
      uuid: '185b4749-247e-4991-8aa2-02629b69a2ed'
    }
  },
  {
    at: 2317,
    frame: {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      uuid: '6011101a-f645-47ff-bbd0-2e2fb15c1086'
    }
  },
  {
    at: 12254,
    frame: {
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'success',
      uuid: 'deb4be94-1113-4306-91e1-046252ad32f0'
    }
  },
  {
    at: 12260,
    frame: {
      type: 'user',
      parent_tool_use_id: null,
      isReplay: true,
      uuid: '2142a8db-37fd-4fec-bb23-14fcba3ff6fd',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Reply with exactly the word: three' }]
      }
    }
  },
  {
    at: 12260,
    frame: {
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: {
        trigger: 'auto',
        pre_tokens: 27312,
        post_tokens: 1867,
        cumulative_dropped_tokens: 25445,
        duration_ms: 9930
      },
      uuid: 'db5b78d1-f1dc-40ac-bac1-55ce5d7d372b'
    }
  },
  {
    at: 12262,
    frame: {
      type: 'user',
      parent_tool_use_id: null,
      isSynthetic: true,
      uuid: '44b8ee75-ae1a-489f-ba01-1b023e3f5651',
      message: { role: 'user', content: [{ type: 'text', text: '[summary scrubbed]' }] }
    }
  },
  {
    at: 12974,
    frame: {
      type: 'assistant',
      user_message_uuid: '2142a8db-37fd-4fec-bb23-14fcba3ff6fd',
      parent_tool_use_id: null,
      uuid: '3422deed-a400-4d8d-8c62-b4fd377e107c',
      message: {
        id: 'msg_011CfrVS97uzcgjNjVghxiqq',
        model: 'claude-haiku-5-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'three' }]
      }
    }
  },
  {
    at: 12998,
    frame: {
      type: 'result',
      subtype: 'success',
      is_error: false,
      terminal_reason: 'completed',
      result: 'three',
      user_message_uuid: '2142a8db-37fd-4fec-bb23-14fcba3ff6fd',
      uuid: '092f4cfd-ec91-40c5-81bc-f5694b42da37'
    }
  }
]
