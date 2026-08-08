import { describe, expect, it } from 'vitest'
import { getServeOptions } from './serve-options'
import { normalizeServeModeArgv } from './serve-mode-argv'

describe('getServeOptions', () => {
  it('parses a clean no-pairing launch', () => {
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-port', '6768', '--serve-no-pairing'])
    ).toEqual({
      json: false,
      wsPort: 6768,
      pairingAddress: null,
      noPairing: true,
      mobilePairing: false,
      recipeJson: false,
      projectRoot: null
    })
  })

  it('rejects no-pairing with mobile-pairing after CLI-form normalize', () => {
    const argv = normalizeServeModeArgv([
      '/opt/Orca/orca-ide',
      'serve',
      '--port',
      '6768',
      '--no-pairing',
      '--mobile-pairing'
    ])
    expect(() => getServeOptions(argv)).toThrow(/either --mobile-pairing or --no-pairing/i)
  })

  it('rejects recipe-json with no-pairing', () => {
    expect(() =>
      getServeOptions([
        'orca',
        '--serve',
        '--serve-recipe-json',
        '--serve-no-pairing',
        '--serve-project-root',
        '/tmp/project'
      ])
    ).toThrow(/requires runtime pairing.*--no-pairing/i)
  })

  it('rejects recipe-json without project-root', () => {
    expect(() => getServeOptions(['orca', '--serve', '--serve-recipe-json'])).toThrow(
      /requires --project-root/i
    )
  })

  it('rejects a --no-pairing typo that would keep pairing on', () => {
    const argv = normalizeServeModeArgv([
      '/opt/Orca/orca-ide',
      'serve',
      '--port',
      '6768',
      '--no-pairng'
    ])
    expect(() => getServeOptions(argv)).toThrow(/Unknown flag --no-pairng.*--no-pairing/i)
  })

  it('still allows unrelated Chromium switches', () => {
    expect(
      getServeOptions([
        '/AppRun',
        '--serve',
        '--serve-port',
        '6768',
        '--disable-gpu',
        '--enable-features=Foo'
      ])
    ).toMatchObject({
      wsPort: 6768,
      noPairing: false
    })
  })
})
