import { describe, expect, it } from 'vitest'
import { classifyOrcadHostUnavailable } from '../orcad/orcad-host-unavailable'
import {
  isWslDistroNotFoundFailure,
  WslDistroNotRegisteredError,
  WslDistroVersion1Error
} from './wsl-distro-unsupported'

describe('distros that cannot host Orca', () => {
  it('says how to convert a WSL 1 distro', () => {
    expect(new WslDistroVersion1Error('Legacy').message).toContain('wsl --set-version Legacy 2')
  })

  it('classifies both refusals as an unsupported host, as the SSH path records them', () => {
    expect(classifyOrcadHostUnavailable(new WslDistroVersion1Error('Legacy'))).toBe(
      'unsupported_host'
    )
    expect(classifyOrcadHostUnavailable(new WslDistroNotRegisteredError('Gone'))).toBe(
      'unsupported_host'
    )
  })

  it.each([
    ['the English sentence', 'There is no distribution with the supplied name.', true],
    [
      'the error code under a localized sentence',
      'Fehler: Wsl/Service/WSL_E_DISTRO_NOT_FOUND',
      true
    ],
    ['an unrelated failure', 'Command "uname -r" failed (exit 1): timeout', false]
  ])('recognizes a missing distro from %s', (_case, message, expected) => {
    expect(isWslDistroNotFoundFailure(new Error(message))).toBe(expected)
  })
})
