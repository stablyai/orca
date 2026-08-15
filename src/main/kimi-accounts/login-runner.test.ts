import { describe, expect, it } from 'vitest'
import { parseKimiLoginInstructions } from './login-runner'

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

  it('drops output that could contain bearer credentials', () => {
    expect(
      parseKimiLoginInstructions(
        'Authorization: Bearer secret\naccess_token: secret\nrefresh_token: secret',
        '/managed/home'
      )
    ).toBeNull()
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
