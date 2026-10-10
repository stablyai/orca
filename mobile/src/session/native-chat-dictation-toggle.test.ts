import { describe, expect, it } from 'vitest'
import {
  nativeChatDictationPhase,
  nativeChatDictationToggleAction
} from './native-chat-dictation-toggle'
import type { DictationStatus } from '../hooks/mobile-dictation-session-state'
import type { FailedStreamFinishPhase } from '../hooks/mobile-dictation-stream-salvage'

function tap(status: DictationStatus, failedStreamFinish: FailedStreamFinishPhase = 'none') {
  return nativeChatDictationToggleAction(nativeChatDictationPhase({ status, failedStreamFinish }))
}

describe('nativeChatDictationToggleAction', () => {
  it('ignores a tap while a failed stream finishes within its grace period', () => {
    expect(nativeChatDictationPhase({ status: 'processing', failedStreamFinish: 'grace' })).toBe(
      'salvaging'
    )
    expect(tap('processing', 'grace')).toBe('ignore')
  })

  it('lets a tap cancel a failed stream finish once the grace period is over', () => {
    expect(tap('processing', 'cancellable')).toBe('cancel')
  })

  it('still cancels a user-started upload on a tap while processing', () => {
    expect(tap('processing')).toBe('cancel')
  })

  it('starts, stops and ignores a tap while starting', () => {
    expect(tap('idle')).toBe('start')
    expect(tap('error')).toBe('start')
    expect(tap('recording')).toBe('stop')
    expect(tap('starting')).toBe('ignore')
  })

  it('treats a leftover salvage phase as idle once processing ended', () => {
    expect(nativeChatDictationPhase({ status: 'error', failedStreamFinish: 'grace' })).toBe('idle')
  })
})
