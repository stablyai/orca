import { describe, expect, it, vi } from 'vitest'
import {
  collectKeyboardInteractiveResponses,
  formatKeyboardInteractivePromptDetail,
  isKeyboardInteractivePasswordPrompt,
  type KeyboardInteractiveSession
} from './ssh-keyboard-interactive'

function createSession(
  overrides: Partial<KeyboardInteractiveSession> = {}
): KeyboardInteractiveSession & { cancelled: { value: boolean } } {
  const cancelled = { value: false }
  return {
    targetId: 'target-1',
    hostDetail: 'example.com',
    requestCredential: vi.fn(async () => 'answer'),
    getCachedPassword: () => null,
    setCachedPassword: vi.fn(),
    markCancelled: () => {
      cancelled.value = true
    },
    isCancelled: () => cancelled.value,
    state: { passwordAutoAnswered: false },
    cancelled,
    ...overrides
  }
}

describe('isKeyboardInteractivePasswordPrompt', () => {
  it('matches masked password prompts', () => {
    expect(isKeyboardInteractivePasswordPrompt({ prompt: 'Password: ', echo: false })).toBe(true)
    expect(isKeyboardInteractivePasswordPrompt({ prompt: "user@host's PASSWORD:" })).toBe(true)
  })

  it('rejects echoed prompts even when they mention a password', () => {
    expect(isKeyboardInteractivePasswordPrompt({ prompt: 'Password: ', echo: true })).toBe(false)
  })

  it('rejects one-time password and OTP prompts', () => {
    expect(isKeyboardInteractivePasswordPrompt({ prompt: 'One-time password:', echo: false })).toBe(
      false
    )
    expect(isKeyboardInteractivePasswordPrompt({ prompt: 'OTP password code:', echo: false })).toBe(
      false
    )
  })

  it('rejects verification prompts that never mention a password', () => {
    expect(isKeyboardInteractivePasswordPrompt({ prompt: 'Passcode:', echo: false })).toBe(false)
    expect(isKeyboardInteractivePasswordPrompt({ prompt: 'Duo push sent', echo: false })).toBe(
      false
    )
  })
})

describe('formatKeyboardInteractivePromptDetail', () => {
  it('joins instructions and prompt on separate lines', () => {
    expect(formatKeyboardInteractivePromptDetail('Pick an option:', 'Passcode: ')).toBe(
      'Pick an option:\nPasscode:'
    )
  })

  it('drops the missing half', () => {
    expect(formatKeyboardInteractivePromptDetail('', 'Passcode: ')).toBe('Passcode:')
    expect(formatKeyboardInteractivePromptDetail('Approve the push. ', '')).toBe(
      'Approve the push.'
    )
  })
})

describe('collectKeyboardInteractiveResponses', () => {
  it('forwards verification prompts with instructions and the echo flag', async () => {
    const requestCredential = vi.fn(async () => '1')
    const session = createSession({ requestCredential })

    const responses = await collectKeyboardInteractiveResponses(session, 'Choose an option:', [
      { prompt: 'Passcode or option (1-2):', echo: true }
    ])

    expect(responses).toEqual(['1'])
    expect(requestCredential).toHaveBeenCalledWith(
      'target-1',
      'keyboard-interactive',
      'Choose an option:\nPasscode or option (1-2):',
      true
    )
  })

  it('answers a password prompt from the cache without prompting', async () => {
    const requestCredential = vi.fn(async () => 'unused')
    const session = createSession({
      requestCredential,
      getCachedPassword: () => 'password-123'
    })

    const responses = await collectKeyboardInteractiveResponses(session, '', [
      { prompt: 'Password: ', echo: false }
    ])

    expect(responses).toEqual(['password-123'])
    expect(requestCredential).not.toHaveBeenCalled()
    expect(session.state.passwordAutoAnswered).toBe(true)
  })

  it('re-prompts when the server rejects the auto-answered cached password', async () => {
    const requestCredential = vi.fn(async () => 'corrected-password')
    const setCachedPassword = vi.fn()
    const session = createSession({
      requestCredential,
      getCachedPassword: () => 'stale-password',
      setCachedPassword,
      state: { passwordAutoAnswered: true }
    })

    const responses = await collectKeyboardInteractiveResponses(session, '', [
      { prompt: 'Password: ', echo: false }
    ])

    expect(responses).toEqual(['corrected-password'])
    expect(requestCredential).toHaveBeenCalledWith('target-1', 'password', 'example.com')
    expect(setCachedPassword).toHaveBeenCalledWith('corrected-password')
  })

  it('collects and caches the password when nothing is cached yet', async () => {
    const requestCredential = vi.fn(async () => 'password-123')
    const setCachedPassword = vi.fn()
    const session = createSession({ requestCredential, setCachedPassword })

    const responses = await collectKeyboardInteractiveResponses(session, '', [
      { prompt: 'Password: ', echo: false },
      { prompt: 'Duo push approval', echo: false }
    ])

    expect(responses).toEqual(['password-123', 'password-123'])
    expect(requestCredential).toHaveBeenNthCalledWith(1, 'target-1', 'password', 'example.com')
    expect(requestCredential).toHaveBeenNthCalledWith(
      2,
      'target-1',
      'keyboard-interactive',
      'Duo push approval',
      false
    )
    expect(setCachedPassword).toHaveBeenCalledWith('password-123')
  })

  it('returns null and marks the session cancelled when the user dismisses a prompt', async () => {
    const session = createSession({ requestCredential: vi.fn(async () => null) })

    const responses = await collectKeyboardInteractiveResponses(session, '', [
      { prompt: 'Duo passcode:', echo: false }
    ])

    expect(responses).toBeNull()
    expect(session.isCancelled()).toBe(true)
  })

  it('short-circuits every later round once cancelled', async () => {
    const requestCredential = vi.fn(async () => 'answer')
    const session = createSession({ requestCredential })
    session.markCancelled()

    const responses = await collectKeyboardInteractiveResponses(session, '', [
      { prompt: 'Duo passcode:', echo: false }
    ])

    expect(responses).toBeNull()
    expect(requestCredential).not.toHaveBeenCalled()
  })

  it('returns null when no credential prompter is available', async () => {
    const session = createSession({ requestCredential: undefined })

    const responses = await collectKeyboardInteractiveResponses(session, '', [
      { prompt: 'Password: ', echo: false }
    ])

    expect(responses).toBeNull()
  })

  it('accepts an empty response without caching it as a password', async () => {
    const requestCredential = vi.fn(async () => '')
    const setCachedPassword = vi.fn()
    const session = createSession({ requestCredential, setCachedPassword })

    const responses = await collectKeyboardInteractiveResponses(session, '', [
      { prompt: 'Password: ', echo: false }
    ])

    expect(responses).toEqual([''])
    expect(setCachedPassword).not.toHaveBeenCalled()
  })
})
