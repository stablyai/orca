import { describe, expect, it } from 'vitest'
import {
  buildToolchainProbeCommand,
  parseBuildToolchainProbe,
  formatMissingToolchainError,
  shouldProbeBuildToolchainAfterNativeDepsFailure
} from './ssh-relay-build-toolchain'

describe('buildToolchainProbeCommand', () => {
  it('probes make and a C++ compiler and detects the package manager', () => {
    const cmd = buildToolchainProbeCommand()
    expect(cmd).toContain('command -v "$t"')
    expect(cmd).toMatch(/\bmake\b/)
    expect(cmd).toMatch(/g\+\+/)
    expect(cmd).toContain('apt-get')
    // Single POSIX-sh line (runs under `/bin/sh -c`), no embedded single quotes
    // that shellEscape would have to wrap.
    expect(cmd).not.toContain('\n')
    expect(cmd).not.toContain("'")
  })
})

describe('parseBuildToolchainProbe', () => {
  it('flags a missing toolchain when make and the C++ compiler are absent', () => {
    const status = parseBuildToolchainProbe('PKG apt-get\n')
    expect(status.toolchainMissing).toBe(true)
    expect(status.present).toEqual([])
    expect(status.packageManager).toBe('apt-get')
  })

  it('treats a full toolchain as present', () => {
    const status = parseBuildToolchainProbe('HAVE make\nHAVE gcc\nHAVE g++\nHAVE python3\nPKG dnf')
    expect(status.toolchainMissing).toBe(false)
    expect(status.present).toContain('make')
    expect(status.present).toContain('g++')
    expect(status.packageManager).toBe('dnf')
  })

  it('still flags missing when make is present but no C++ compiler is', () => {
    const status = parseBuildToolchainProbe('HAVE make\nHAVE gcc\nHAVE python3')
    expect(status.toolchainMissing).toBe(true)
    expect(status.packageManager).toBeNull()
  })

  it('accepts clang++ as the C++ compiler', () => {
    const status = parseBuildToolchainProbe('HAVE make\nHAVE clang\nHAVE clang++\nHAVE python3')
    expect(status.toolchainMissing).toBe(false)
  })

  it('ignores shell noise around the markers', () => {
    const status = parseBuildToolchainProbe(
      'Welcome to Acme\nHAVE make\nHAVE g++\nHAVE python3\nMOTD line\nPKG apk'
    )
    expect(status.toolchainMissing).toBe(false)
    expect(status.packageManager).toBe('apk')
  })
})

describe('shouldProbeBuildToolchainAfterNativeDepsFailure', () => {
  it('matches node-gyp missing build-tool output', () => {
    expect(
      shouldProbeBuildToolchainAfterNativeDepsFailure('gyp ERR! stack Error: not found: make')
    ).toBe(true)
    expect(
      shouldProbeBuildToolchainAfterNativeDepsFailure(
        'node-gyp ERR! Could not find any Python installation'
      )
    ).toBe(true)
  })

  it('does not match unrelated npm failures', () => {
    expect(shouldProbeBuildToolchainAfterNativeDepsFailure('npm ERR! network ETIMEDOUT')).toBe(
      false
    )
    expect(
      shouldProbeBuildToolchainAfterNativeDepsFailure('npm ERR! E404 Not Found node-pty')
    ).toBe(false)
  })
})

describe('formatMissingToolchainError', () => {
  it('lists the missing tools and a package-manager-specific install command', () => {
    const status = parseBuildToolchainProbe('PKG apt-get')
    const msg = formatMissingToolchainError(status, 'gyp ERR! not found: make')
    expect(msg).toContain('make')
    expect(msg).toContain('a C++ compiler (g++ or clang++)')
    expect(msg).toContain('python3')
    expect(msg).toContain('sudo apt-get install -y build-essential python3')
    // Tailored hint replaces the generic distro list.
    expect(msg).not.toContain('Fedora/RHEL:')
    // Original error retained for triage.
    expect(msg).toContain('gyp ERR! not found: make')
  })

  it('falls back to a multi-distro list when no package manager was detected', () => {
    const status = parseBuildToolchainProbe('')
    const msg = formatMissingToolchainError(status, 'exit 1')
    expect(msg).toContain('Debian/Ubuntu:')
    expect(msg).toContain('Fedora/RHEL:')
    expect(msg).toContain('Arch:')
    expect(msg).toContain('Alpine:')
  })

  it('only lists the genuinely missing pieces', () => {
    const status = parseBuildToolchainProbe('HAVE make\nHAVE python3\nPKG pacman')
    const msg = formatMissingToolchainError(status, 'err')
    expect(msg).toContain('a C++ compiler (g++ or clang++)')
    expect(msg).not.toMatch(/\(make,/)
    expect(msg).toContain('sudo pacman -S --needed base-devel python')
  })
})
