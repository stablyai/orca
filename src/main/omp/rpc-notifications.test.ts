import { afterEach, expect, it } from 'vitest'
import { projectStructuredItemsToNativeChat } from '../../shared/agent-session/view/structured-agent-session-projection'
import {
  nativeChatNoticeBlock,
  nativeChatNoticeLook
} from '../../shared/native-chat/native-chat-notice'
import {
  closeOmpRpcAdapterFixtures,
  setupOmpRpcAdapter as setup
} from './rpc-session-adapter.test-fixture'

afterEach(closeOmpRpcAdapterFixtures)

it('omits automatic tool roster announcements while preserving ordinary notices and requested output', async () => {
  const h = await setup()
  const mounted = 'xd://: mounted mcp__context_mode_ctx_execute'
  h.connection.receive({ type: 'notice', source: 'xdev', level: 'info', message: mounted })
  h.connection.receive({ type: 'notice', source: 'xdev', level: 'info', message: mounted })
  h.connection.receive({
    type: 'notice',
    source: 'xdev',
    level: 'info',
    message: 'xd://: unmounted mcp__context_mode_ctx_execute'
  })
  h.connection.receive({
    type: 'notice',
    source: 'extension',
    level: 'info',
    message: 'Extension ready'
  })
  h.connection.receive({ type: 'notice', level: 'info', message: 'Session ready' })
  h.connection.receive({ type: 'command_output', text: mounted })
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'ordinary-notice',
    method: 'notify',
    message: 'Task complete',
    notifyType: 'info'
  })
  expect((await h.rig.rows()).map((row) => row.body)).toMatchObject([
    { kind: 'status', text: 'Extension ready', tone: 'notice' },
    { kind: 'status', text: 'Session ready', tone: 'notice' },
    { kind: 'status', text: 'xd://: mounted mcp__context_mode_ctx_execute', tone: 'notice' },
    { kind: 'status', text: 'Task complete', tone: 'notice' }
  ])
})

it.each([
  ['warning', 'warning'],
  ['error', 'error']
] as const)('renders OMP %s notifications using existing Chat notices', async (level, tone) => {
  const h = await setup()
  const message = 'xd://: mounted mcp__orca_component_fixtures_list_fixtures'
  h.connection.receive({ type: 'notice', level, message, source: 'xdev' })
  h.connection.receive({
    type: 'extension_ui_request',
    id: 'extension-notice',
    method: 'notify',
    message: 'Extension ready',
    notifyType: level
  })
  const messages = projectStructuredItemsToNativeChat(await h.rig.rows())
  expect(messages).toHaveLength(2)
  for (const [index, text] of [message, 'Extension ready'].entries()) {
    const row = messages[index]!
    expect(row.role).toBe('system')
    const block = nativeChatNoticeBlock(row.blocks)
    expect(block?.text).toBe(text)
    expect(block && nativeChatNoticeLook(block)).toEqual({ kind: 'line', tone })
  }
})
