import { describe, expect, it } from 'vitest'
import type { Translate } from '../../../i18n/mobile-i18n'
import { mobileNativeChatAgentNotice } from './mobile-native-chat-agent-presence-copy'

const t: Translate = (_key, fallback) => fallback

function restartedNotice(phase: { kind: 'idle' } | { kind: 'restarting'; mode: 'resume' }) {
  return mobileNativeChatAgentNotice({
    presence: { exit: null, restartFrom: { sessionId: 'old' } },
    agent: 'claude',
    sessionId: 'new',
    onShowTerminal: undefined,
    onDismissRestart: () => {},
    restart: { phase, canResume: true, restart: () => {} },
    t
  })
}

describe('the restarted-agent notice', () => {
  // Dismissing mid-restart would hide a later failure and its retry button.
  it('keeps OK disabled while a restart is in flight', () => {
    const ok = restartedNotice({ kind: 'restarting', mode: 'resume' })?.actions.at(-1)
    expect(ok).toMatchObject({ label: 'OK', disabled: true })
  })

  it('lets OK dismiss it once nothing is in flight', () => {
    const ok = restartedNotice({ kind: 'idle' })?.actions.at(-1)
    expect(ok).toMatchObject({ label: 'OK', disabled: false })
  })
})
