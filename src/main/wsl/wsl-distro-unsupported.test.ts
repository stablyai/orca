import { describe, expect, it } from 'vitest'
import { classifyOrcadHostUnavailable } from '../orcad/orcad-host-unavailable'
import { OrcadHostGlibcUnsupportedError } from '../managed-server/lifecycle/orcad-runtime-target'
import { RemoteNodeRuntimeSelfTestError } from '../ssh/orcad-remote-node-runtime-report'
import {
  isWslDistroNotFoundFailure,
  WslDistroNotRegisteredError,
  WslDistroVersion1Error,
  wslUnsupportedDistroFixMessage
} from './wsl-distro-unsupported'

const NIXOS_STUB_OUTPUT =
  'Could not start dynamically linked executable: node\n' +
  'NixOS cannot run dynamically linked executables intended for generic\n' +
  'linux environments out of the box.'

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

  it('adds the glibc fix for a distro, leaving the shared refusal SSH shows as it was', () => {
    const error = new OrcadHostGlibcUnsupportedError('linux-arm64-glibc', '2.27')
    expect(error.name).toBe('OrcadHostUnsupportedError')
    expect(error.message).toBe('No Orca runtime supports linux-arm64-glibc with glibc 2.27.')
    expect(wslUnsupportedDistroFixMessage(error)).toBe(
      'No Orca runtime supports linux-arm64-glibc with glibc 2.27. Use a Linux release with ' +
        'glibc 2.28 or newer (for example Ubuntu 20.04 or Debian 10 and later).'
    )
  })

  it('tells a NixOS distro to turn on nix-ld, leaving the shared self-test wording as it was', () => {
    const error = new RemoteNodeRuntimeSelfTestError(127, NIXOS_STUB_OUTPUT)
    expect(error.message).toMatch(/^The pinned Node runtime did not run on the host \(exit 127\)/)
    const fix = wslUnsupportedDistroFixMessage(error)
    expect(fix).toMatch(/^NixOS can’t run Orca’s Node runtime/)
    expect(fix).toContain('programs.nix-ld.enable = true;')
    expect(fix).toContain(`(exit 127: ${NIXOS_STUB_OUTPUT})`)
  })

  it('has no fix for other failures', () => {
    expect(
      wslUnsupportedDistroFixMessage(new RemoteNodeRuntimeSelfTestError(139, 'Segmentation fault'))
    ).toBeNull()
    expect(wslUnsupportedDistroFixMessage(new Error('bridge refused'))).toBeNull()
  })
})
