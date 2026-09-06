import { describe, expect, it } from 'vitest'
import { getServeOptions } from './serve-options'
import { normalizeServeModeArgv } from './serve-mode-argv'

describe('getServeOptions', () => {
  it('parses a valid launch', () => {
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

  it('accepts equals-form values in the normalized shape', () => {
    expect(
      getServeOptions([
        '/AppRun',
        '--serve',
        '--serve-port=6768',
        '--serve-pairing-address=127.0.0.1',
        '--serve-project-root=/tmp/repo'
      ])
    ).toMatchObject({
      wsPort: 6768,
      pairingAddress: '127.0.0.1',
      projectRoot: '/tmp/repo'
    })
  })

  it('uses the final occurrence of each value flag', () => {
    expect(
      getServeOptions([
        '/AppRun',
        '--serve',
        '--serve-port',
        '6768',
        '--serve-port=6769',
        '--serve-pairing-address',
        'first.example',
        '--serve-pairing-address=last.example',
        '--serve-project-root',
        '/first',
        '--serve-project-root=/last'
      ])
    ).toMatchObject({
      wsPort: 6769,
      pairingAddress: 'last.example',
      projectRoot: '/last'
    })
  })

  it('applies missing or invalid values only to the final occurrence', () => {
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-port', '--serve-port', '6768']).wsPort
    ).toBe(6768)
    expect(() =>
      getServeOptions(['/AppRun', '--serve', '--serve-port', '6768', '--serve-port'])
    ).toThrow('Missing value for --serve-port.')
    expect(() =>
      getServeOptions(['/AppRun', '--serve', '--serve-port', '6768', '--serve-port=bad'])
    ).toThrow('Invalid --serve-port value: bad')
  })

  it('uses the final value of mixed boolean aliases', () => {
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-no-pairing', '--no-pairing=false']).noPairing
    ).toBe(false)
    expect(
      getServeOptions(['/AppRun', '--serve', '--no-pairing=false', '--serve-no-pairing']).noPairing
    ).toBe(true)
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-mobile-pairing', '--mobile-pairing=0'])
        .mobilePairing
    ).toBe(false)
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-recipe-json', '--recipe-json=false'])
        .recipeJson
    ).toBe(false)
  })

  it('keeps JSON enabled for an equals-form global flag', () => {
    expect(getServeOptions(['/AppRun', '--serve', '--json=false']).json).toBe(true)
  })

  it('accepts an equals-form value that resembles a pairing flag', () => {
    const argv = normalizeServeModeArgv(['/AppRun', 'serve', '--pairing-address=--no-pairng'])
    expect(getServeOptions(argv).pairingAddress).toBe('--no-pairng')
  })

  it('shares cross-flag validation with the CLI-form launch', () => {
    const argv = normalizeServeModeArgv([
      '/opt/orca/orca-ide',
      'serve',
      '--no-pairing',
      '--mobile-pairing'
    ])
    expect(() => getServeOptions(argv)).toThrow(/either --mobile-pairing or --no-pairing/i)
  })

  it('rejects recipe JSON without runtime pairing and a project root', () => {
    expect(() =>
      getServeOptions([
        '/AppRun',
        '--serve',
        '--serve-recipe-json',
        '--serve-no-pairing',
        '--serve-project-root',
        '/tmp/repo'
      ])
    ).toThrow(/requires runtime pairing.*--no-pairing/i)
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-recipe-json'])).toThrow(
      /requires --project-root/i
    )
  })

  it('rejects a security-shaped typo while allowing Chromium switches', () => {
    const normalized = normalizeServeModeArgv(['/AppRun', 'serve', '--no-pairng'])
    expect(() => getServeOptions(normalized)).toThrow(/Unknown flag --no-pairng.*--no-pairing/i)
    expect(
      getServeOptions(['/AppRun', '--serve', '--disable-gpu', '--disable-features=Vulkan'])
        .noPairing
    ).toBe(false)
  })

  it('still rejects a flag-shaped space value, as the CLI does', () => {
    expect(() =>
      getServeOptions(['/AppRun', '--serve', '--serve-pairing-address', '--no-pairng'])
    ).toThrow(/Unknown flag --no-pairng.*--no-pairing/i)
  })

  it('ignores serve-looking arguments after the terminator', () => {
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

  it('requires a port value', () => {
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-port'])).toThrow(
      'Missing value for --serve-port.'
    )
  })

  it.each(['', '--serve-json', '--'])('rejects an unusable port value %j', (value) => {
    expect(() => getServeOptions(['/AppRun', '--serve', '--serve-port', value])).toThrow(
      'Missing value for --serve-port.'
    )
  })
})
