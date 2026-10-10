import { describe, expect, it, vi } from 'vitest'
import {
  MOBILE_DICTATION_NO_SPEECH_MESSAGE,
  deliverDictationFinish,
  readDictationFinish
} from './mobile-dictation-finish-outcome'

describe('readDictationFinish', () => {
  it('keeps the text and the provider error a newer desktop reports on finish', () => {
    expect(readDictationFinish({ text: ' First part. ', error: 'Flush failed' }, null)).toEqual({
      text: 'First part.',
      errorMessage: 'Flush failed'
    })
  })

  it('shows a failure a chunk already reported once, not twice', () => {
    expect(readDictationFinish({ text: 'kept', error: 'Soniox closed' }, 'Soniox closed')).toEqual({
      text: 'kept',
      errorMessage: 'Soniox closed'
    })
  })

  it('reads an old desktop reply without an error member as success', () => {
    expect(readDictationFinish({ dictationId: 'd', text: 'hi' }, null)).toEqual({
      text: 'hi',
      errorMessage: null
    })
  })

  it('degrades unreadable members to no speech', () => {
    expect(readDictationFinish({ text: 5, error: 7 }, null)).toEqual({
      text: '',
      errorMessage: MOBILE_DICTATION_NO_SPEECH_MESSAGE
    })
  })

  it('still throws on a null body so the caller cancels the session', () => {
    expect(() => readDictationFinish(null, null)).toThrow(TypeError)
  })
})

describe('deliverDictationFinish', () => {
  it('inserts the text before reporting the error', () => {
    const calls: string[] = []
    deliverDictationFinish(
      { text: 'kept', errorMessage: 'Flush failed' },
      (text) => calls.push(`text:${text}`),
      (error) => calls.push(`error:${error.message}`)
    )
    expect(calls).toEqual(['text:kept', 'error:Flush failed'])
  })

  it('reports nothing extra for a clean finish', () => {
    const onFailure = vi.fn()
    deliverDictationFinish({ text: 'kept', errorMessage: null }, vi.fn(), onFailure)
    expect(onFailure).not.toHaveBeenCalled()
  })
})
