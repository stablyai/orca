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

  it('ignores recognized serve flags after the option terminator', () => {
    expect(
      getServeOptions(['/AppRun', '--serve', '--', '--serve-port', '1', '--serve-no-pairing'])
    ).toEqual({
      json: false,
      pairingAddress: null,
      noPairing: false,
      mobilePairing: false,
      recipeJson: false,
      projectRoot: null
    })
  })

  it.each(['--serve-port', '--serve-pairing-address', '--serve-project-root'])(
    'rejects a missing value for %s',
    (flag) => {
      expect(() => getServeOptions(['/AppRun', '--serve', flag])).toThrow(
        `Missing value for ${flag}.`
      )
    }
  )

  it.each([
    ['an empty value', ''],
    ['another flag', '--serve-json'],
    ['the option terminator', '--']
  ])('rejects %s after --serve-port', (_description, value) => {
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-port', value])).toThrow(
      'Missing value for --serve-port.'
    )
  })
})
