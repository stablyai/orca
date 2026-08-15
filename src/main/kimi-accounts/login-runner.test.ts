import { StringDecoder } from 'node:string_decoder'
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

  it('strips sentence punctuation that follows the verification URL', () => {
    expect(
      parseKimiLoginInstructions(
        'Open https://auth.kimi.com/device.\nEnter code: ABCD-EFGH',
        '/managed/home'
      )?.verificationUrl
    ).toBe('https://auth.kimi.com/device')
    expect(
      parseKimiLoginInstructions(
        'Visit (https://auth.kimi.com/device?user_code=ABCD-EFGH),',
        '/managed/home'
      )?.verificationUrl
    ).toBe('https://auth.kimi.com/device?user_code=ABCD-EFGH')
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

  it('drops a bare bearer credential line', () => {
    const instructions = parseKimiLoginInstructions(
      [
        'Open https://auth.kimi.com/device in your browser.',
        'Enter code: ABCD-EFGH',
        'Bearer secret-token-value'
      ].join('\n'),
      '/managed/home'
    )

    expect(instructions?.message).toBe(
      'Open https://auth.kimi.com/device in your browser.\nEnter code: ABCD-EFGH'
    )
  })

  it('redacts a non-ASCII managed home after a UTF-8 split', () => {
    const managedHomePath = '/private/管理/kimi-home'
    const suffix = 'Open https://auth.kimi.com/device in your browser.\nEnter code: ABCD-EFGH'
    const full = `Kimi login: ${managedHomePath}\n${suffix}\n`
    const bytes = Buffer.from(full, 'utf8')
    const midChar = Buffer.from('理', 'utf8')
    const split = bytes.indexOf(Buffer.from(managedHomePath, 'utf8')) + midChar.length - 1
    const decoder = new StringDecoder('utf8')
    const streamed = decoder.write(bytes.subarray(0, split)) + decoder.write(bytes.subarray(split))

    expect(streamed).toContain(managedHomePath)
    const instructions = parseKimiLoginInstructions(streamed, managedHomePath)
    expect(instructions?.message).toBe(suffix)
    expect(instructions?.message).not.toContain('\uFFFD')
  })

  it('keeps stdout and stderr UTF-8 sequences on separate decoders', () => {
    const managedHomePath = '/private/管理/kimi-home'
    const bytes = Buffer.from(managedHomePath, 'utf8')
    const split = bytes.indexOf(Buffer.from('理', 'utf8')) + 1
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const assembled =
      stdoutDecoder.write(bytes.subarray(0, split)) + stdoutDecoder.write(bytes.subarray(split))
    const other = stderrDecoder.write(Buffer.from('noise'))

    expect(assembled).toBe(managedHomePath)
    expect(other).toBe('noise')
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
