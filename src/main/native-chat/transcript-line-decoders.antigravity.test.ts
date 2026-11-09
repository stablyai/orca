import { describe, expect, it } from 'vitest'
import {
  nativeChatMessagesShareTranscriptRow,
  nativeChatSemanticRowId
} from '../../shared/native-chat/native-chat-types'
import { parseAskFromToolInput } from '../../shared/native-chat/input/native-chat-ask'
import { diffFromToolCall } from '../../shared/native-chat/tools/native-chat-diff'
import { describeToolInput } from '../../shared/native-chat/tools/native-chat-tool-summary'
import { decodeAntigravityTranscriptLine } from './transcript-line-decoders'
import { decodeAntigravityTurnLifecycle } from './transcript-turn-lifecycle'

describe('decodeAntigravityTranscriptLine', () => {
  it('strips Antigravity metadata envelopes from USER_INPUT while keeping user text and media', () => {
    const line = JSON.stringify({
      step_index: 3,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      created_at: '2026-11-08T11:46:24+08:00',
      content: [
        '<USER_REQUEST>',
        'Build and test on the iOS simulator.',
        '</USER_REQUEST>',
        '<ADDITIONAL_METADATA>',
        'The current time is: 2026-11-08T11:46:24+08:00.',
        '</ADDITIONAL_METADATA>',
        '<USER_SETTINGS_CHANGE>',
        'The model has changed to gemini-4-argon.',
        '</USER_SETTINGS_CHANGE>'
      ].join('\n'),
      media: [
        { mime_type: 'image/png', uri: '/tmp/screenshot.png' },
        { mime_type: 'image/png', uri: 'file://remote-host/share/diagram.png' }
      ]
    })

    expect(decodeAntigravityTranscriptLine(line, 'fb-1')).toEqual({
      id: 'fb-1:step-3',
      role: 'user',
      blocks: [
        { type: 'image-ref', path: '/tmp/screenshot.png' },
        { type: 'image-ref', url: 'file://remote-host/share/diagram.png' },
        { type: 'text', text: 'Build and test on the iOS simulator.' }
      ],
      timestamp: Date.parse('2026-11-08T11:46:24+08:00'),
      source: 'transcript'
    })
  })

  it('preserves JSON string Content in write_file and quoted strings in transcript_full.jsonl', () => {
    const line = JSON.stringify({
      step_index: 5,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-08T11:47:00+08:00',
      tool_calls: [
        {
          name: 'write_file',
          args: {
            Path: '/repo/package.json',
            Content: '{"name":"demo","version":"1.0.0"}'
          }
        },
        {
          name: 'search_web',
          args: {
            query: '"exact phrase"'
          }
        }
      ]
    })
    const decoded = decodeAntigravityTranscriptLine(
      line,
      '/tmp/brain/s1/.system_generated/logs/transcript_full.jsonl:0000000000000000'
    )
    if (!decoded || Array.isArray(decoded)) {
      throw new Error('Expected single assistant message')
    }
    const [writeBlock, searchBlock] = decoded.blocks
    if (writeBlock?.type !== 'tool-call' || searchBlock?.type !== 'tool-call') {
      throw new Error('Expected tool-call blocks')
    }
    expect(diffFromToolCall(writeBlock.name, writeBlock.input)).toEqual([
      { kind: 'meta', text: '/repo/package.json' },
      { kind: 'add', text: '{"name":"demo","version":"1.0.0"}' }
    ])
    expect(searchBlock.input).toEqual({ query: '"exact phrase"' })
  })

  it('splits PLANNER_RESPONSE thinking and assistant blocks into paired transcript rows', () => {
    const line = JSON.stringify({
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-08T11:46:35+08:00',
      thinking: 'Inspecting the mobile workspace first.',
      content: 'Checking your iOS setup now.',
      model: 'gemini-4-argon',
      tool_calls: [
        {
          id: 'call-1',
          name: 'default_api:edit_file',
          arguments: {
            Path: '/repo/mobile/app.json',
            Target: '"old"',
            Replacement: '"new"'
          }
        },
        {
          id: 'call-2',
          name: 'run_command',
          arguments: {
            CommandLine: '"pnpm test"',
            toolSummary: '"Run unit tests"'
          }
        },
        {
          id: 'call-3',
          name: 'call_mcp_tool',
          arguments: {
            ServerName: 'chrome-devtools',
            ToolName: 'take_screenshot',
            Arguments: { fullPage: true }
          }
        },
        {
          id: 'call-4',
          name: 'mcp_chrome-devtools_list_pages',
          arguments: {}
        }
      ]
    })

    const decoded = decodeAntigravityTranscriptLine(line, 'fb-4')
    expect(Array.isArray(decoded)).toBe(true)
    if (!Array.isArray(decoded)) {
      throw new Error('Expected split [reasoning, assistant] messages')
    }
    const [reasoning, assistant] = decoded
    expect(reasoning).toEqual({
      id: 'fb-4:step-4:reasoning',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Inspecting the mobile workspace first.' }],
      timestamp: Date.parse('2026-11-08T11:46:35+08:00'),
      source: 'transcript'
    })
    expect(assistant).toMatchObject({
      id: 'fb-4:step-4',
      role: 'assistant',
      model: 'gemini-4-argon'
    })
    expect(nativeChatSemanticRowId(reasoning!)).toBe('fb-4:step-4')
    expect(nativeChatMessagesShareTranscriptRow(reasoning!, assistant!)).toBe(true)

    const editBlock = assistant!.blocks[1]
    const cmdBlock = assistant!.blocks[2]
    const mcpBlock = assistant!.blocks[3]
    const eagerMcpBlock = assistant!.blocks[4]
    if (
      editBlock?.type !== 'tool-call' ||
      cmdBlock?.type !== 'tool-call' ||
      mcpBlock?.type !== 'tool-call' ||
      eagerMcpBlock?.type !== 'tool-call'
    ) {
      throw new Error('Expected tool-call blocks')
    }
    expect(editBlock.name).toBe('edit_file')
    expect(diffFromToolCall(editBlock.name, editBlock.input)).toEqual([
      { kind: 'meta', text: '/repo/mobile/app.json' },
      { kind: 'del', text: 'old' },
      { kind: 'add', text: 'new' }
    ])
    expect(cmdBlock.input).toEqual({
      CommandLine: 'pnpm test',
      toolSummary: 'Run unit tests'
    })
    expect(describeToolInput(cmdBlock.input)).toBe('pnpm test')
    expect(mcpBlock.mcpIdentity).toEqual({
      server: 'chrome-devtools',
      tool: 'take_screenshot'
    })
    expect(eagerMcpBlock.mcpIdentity).toEqual({
      server: 'chrome-devtools',
      tool: 'list_pages'
    })
  })

  it('extracts ask_question prompts with is_multi_select', () => {
    const askLine = JSON.stringify({
      step_index: 7,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-08T11:51:43+08:00',
      tool_calls: [
        {
          id: 'ask-1',
          name: 'ask_question',
          arguments: {
            questions: [
              {
                question: 'Which capabilities do you want?',
                is_multi_select: true,
                options: ['(Recommended) Full transcript', 'TUI takeover']
              }
            ]
          }
        }
      ]
    })
    const decodedAsk = decodeAntigravityTranscriptLine(askLine, 'fb-7')
    if (!decodedAsk || Array.isArray(decodedAsk)) {
      throw new Error('Expected single assistant message for tool-only PLANNER_RESPONSE')
    }
    const toolBlock = decodedAsk.blocks[0]
    if (toolBlock?.type !== 'tool-call') {
      throw new Error('Expected tool-call block')
    }
    expect(parseAskFromToolInput(toolBlock.name, toolBlock.input)).toEqual({
      questions: [
        {
          question: 'Which capabilities do you want?',
          multiSelect: true,
          options: [{ label: '(Recommended) Full transcript' }, { label: 'TUI takeover' }]
        }
      ]
    })
  })

  it('tracks Antigravity turn lifecycle from USER_INPUT to terminal PLANNER_RESPONSE', () => {
    const userLine = JSON.stringify({
      step_index: 1,
      type: 'USER_INPUT',
      created_at: '2026-11-08T11:46:24+08:00',
      content: '<USER_REQUEST>\nHello\n</USER_REQUEST>'
    })
    const toolTurnLine = JSON.stringify({
      step_index: 2,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-08T11:46:28+08:00',
      tool_calls: [{ name: 'read_file', arguments: { Path: '/tmp/a' } }]
    })
    const finalReplyLine = JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-08T11:46:35+08:00',
      content: 'All done.'
    })
    const emptyErrorReplyLine = JSON.stringify({
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      status: 'ERROR',
      created_at: '2026-11-08T11:46:40+08:00'
    })

    expect(decodeAntigravityTurnLifecycle(userLine, 'fb-1')).toEqual({
      state: 'working',
      turnId: 'fb-1:step-1',
      timestamp: Date.parse('2026-11-08T11:46:24+08:00')
    })
    expect(decodeAntigravityTurnLifecycle(toolTurnLine, 'fb-2')).toBeNull()
    expect(decodeAntigravityTurnLifecycle(finalReplyLine, 'fb-3')).toEqual({
      state: 'completed',
      turnId: 'fb-3:step-3',
      timestamp: Date.parse('2026-11-08T11:46:35+08:00')
    })
    expect(decodeAntigravityTurnLifecycle(emptyErrorReplyLine, 'fb-4')).toEqual({
      state: 'completed',
      turnId: 'fb-4:step-4',
      timestamp: Date.parse('2026-11-08T11:46:40+08:00')
    })
  })
})
