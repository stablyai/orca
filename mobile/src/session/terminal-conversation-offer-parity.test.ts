// The phone half of src/main/runtime/terminal-conversation-offer-parity.test.ts: a shipped phone
// reading the folded status and a capable phone reading the field and offer must decide alike.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shouldDismissKeyboardAfterTerminalSend } from './agent-send-keyboard-dismissal'
import {
  resolveMobileNativeChat,
  resolveMobileNativeChatFileSessionId,
  type MobileNativeChatTab
} from './mobile-native-chat-eligibility'
import { resolveMobileTerminalTabOwnedAgentId } from './mobile-terminal-tab-agent'

type PhoneTab = MobileNativeChatTab & { title: string; launchAgent?: 'codex' }
type Frames = Record<string, { oldPhone: PhoneTab; capablePhone: PhoneTab }>

const frames: Frames = JSON.parse(
  readFileSync(
    join(
      __dirname,
      '../../../src/shared/__fixtures__/terminal-conversation-offer-parity-frames.json'
    ),
    'utf8'
  )
)

function decisions(tab: PhoneTab) {
  const chat = resolveMobileNativeChat(tab, true)
  return {
    chat: chat ? { agent: chat.agent, sessionId: chat.sessionId } : null,
    fileSessionId: resolveMobileNativeChatFileSessionId(tab),
    ownedAgent: resolveMobileTerminalTabOwnedAgentId(tab),
    dismissesKeyboard: shouldDismissKeyboardAfterTerminalSend({ ...tab, type: 'terminal' }, true)
  }
}

const S = 'session-S'
const expected: Record<string, ReturnType<typeof decisions>> = {
  'neutral PTY title under a shell leaf title': {
    chat: { agent: 'codex', sessionId: S },
    fileSessionId: S,
    ownedAgent: 'codex',
    dismissesKeyboard: false
  },
  'shell PTY title under a neutral leaf title': {
    chat: { agent: 'codex', sessionId: null },
    fileSessionId: null,
    ownedAgent: 'codex',
    dismissesKeyboard: true
  },
  'shell tracker title over a neutral PTY title': {
    chat: { agent: 'codex', sessionId: S },
    fileSessionId: S,
    ownedAgent: 'codex',
    dismissesKeyboard: false
  },
  'neutral tracker title over a shell PTY title': {
    chat: { agent: 'codex', sessionId: null },
    fileSessionId: null,
    ownedAgent: 'codex',
    dismissesKeyboard: true
  },
  'a retained tool as a live signal': {
    chat: { agent: 'codex', sessionId: S },
    fileSessionId: S,
    ownedAgent: 'codex',
    dismissesKeyboard: true
  },
  'a retained question as a live signal': {
    chat: { agent: 'codex', sessionId: S },
    fileSessionId: S,
    ownedAgent: 'codex',
    dismissesKeyboard: true
  },
  'the builder early return with a surviving facet': {
    chat: { agent: 'codex', sessionId: null },
    fileSessionId: null,
    ownedAgent: 'codex',
    dismissesKeyboard: true
  },
  'a Claude management PTY title': {
    chat: { agent: 'codex', sessionId: null },
    fileSessionId: null,
    ownedAgent: 'codex',
    dismissesKeyboard: true
  },
  'an aged no-launch remnant under a shell title (genuine status without an agent)': {
    chat: null,
    fileSessionId: S,
    ownedAgent: null,
    dismissesKeyboard: false
  },
  'the same remnant with a launch record': {
    chat: { agent: 'codex', sessionId: S },
    fileSessionId: S,
    ownedAgent: 'codex',
    dismissesKeyboard: false
  }
}

describe('old and capable phones decide alike on the same host offer', () => {
  it('covers every host case', () => {
    expect(Object.keys(frames).sort()).toEqual(Object.keys(expected).sort())
  })

  it.each(Object.entries(expected))('%s', (name, decided) => {
    const { oldPhone, capablePhone } = frames[name]!
    expect(decisions(capablePhone)).toEqual(decisions(oldPhone))
    expect(decisions(capablePhone)).toEqual(decided)
  })
})
