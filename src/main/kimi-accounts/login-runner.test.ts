import { describe, expect, it } from 'vitest'
import { parseKimiLoginInstructions, retainRecentLoginOutput } from './login-runner'

describe('parseKimiLoginInstructions', () => {
  it('keeps only browser instructions and hides the managed home', () => {
    const instructions = parseKimiLoginInstructions(
      [
        'Open https://auth.kimi.com/device in your browser.',
        'Enter code: ABCD-EFGH',
        'Writing /private/managed/home/credentials/kimi-code.json'
      ].join('\n'),
      '/private/managed/home'
    )

    expect(instructions).toEqual({
      verificationUrl: 'https://auth.kimi.com/device',
      message: 'Open https://auth.kimi.com/device in your browser.\nEnter code: ABCD-EFGH'
    })
  })

  it('drops lines that could contain bearer credentials', () => {
    const instructions = parseKimiLoginInstructions(
      [
        'Open https://auth.kimi.com/device in your browser.',
        'Enter code: ABCD-EFGH',
        'Authorization: Bearer secret',
        'access_token: secret',
        'refresh_token: secret'
      ].join('\n'),
      '/managed/home'
    )

    expect(instructions).toEqual({
      verificationUrl: 'https://auth.kimi.com/device',
      message: 'Open https://auth.kimi.com/device in your browser.\nEnter code: ABCD-EFGH'
    })
    expect(instructions?.message).not.toMatch(/secret|bearer|access_token|refresh_token/i)
  })

  it('drops a truncated leading line so a cut managed-home path cannot leak', () => {
    const managedHomePath = '/private/managed/home'
    const suffix = 'Open https://auth.kimi.com/device\nEnter code: ABCD-EFGH'
    const truncated = retainRecentLoginOutput(
      `${'x'.repeat(7_900)}${managedHomePath}/credentials/kimi-code.json\n${suffix}`
    )

    expect(truncated).toBe(suffix)
    expect(truncated).not.toContain(managedHomePath)
    expect(parseKimiLoginInstructions(truncated, managedHomePath)?.message).toBe(suffix)
  })

  it('waits until a verification URL is available', () => {
    expect(parseKimiLoginInstructions('Enter code: ABCD-EFGH', '/managed/home')).toBeNull()
  })

  it('waits for the user code when the verification URL arrives first', () => {
    expect(
      parseKimiLoginInstructions(
        'Open https://auth.kimi.com/device in your browser.',
        '/managed/home'
      )
    ).toBeNull()
  })
})
