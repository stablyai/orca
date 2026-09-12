import { describe, expect, it } from 'vitest'
import {
  buildToolchainProbeCommand,
  parseBuildToolchainProbe,
  formatMissingToolchainError,
  formatNodeHeadersDownloadError,
  formatSkippedNodePtyWarning,
  isNodeHeadersDownloadFailure,
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

describe('formatSkippedNodePtyWarning', () => {
  it('quotes the tailored install command when a package manager was detected', () => {
    const warning = formatSkippedNodePtyWarning(parseBuildToolchainProbe('PKG dnf'))
    expect(warning).toContain('skipping node-pty')
    expect(warning).toContain('sudo dnf install -y make gcc gcc-c++ python3')
  })

  it('stays distro-neutral when no package manager was detected', () => {
    // The hint list is the cross-distro menu here; quoting its first line would name Debian on any host.
    const warning = formatSkippedNodePtyWarning(parseBuildToolchainProbe(''))
    expect(warning).not.toContain('apt-get')
    expect(warning).toContain('install a C/C++ toolchain')
  })
})

// Verbatim shape of the STA-6674 failure: node-gyp on a host whose nodejs.org is refused.
const HEADERS_REFUSED =
  'npm error gyp http GET https://nodejs.org/download/release/v24.12.0/node-v24.12.0-headers.tar.gz\n' +
  'npm error gyp http fetch GET https://nodejs.org/download/release/v24.12.0/node-v24.12.0-headers.tar.gz attempt 1 failed with ECONNREFUSED\n' +
  'npm error gyp ERR! configure error\n' +
  'npm error gyp ERR! stack FetchError: request to https://nodejs.org/download/release/v24.12.0/node-v24.12.0-headers.tar.gz failed, reason: connect ECONNREFUSED 127.0.0.1:443'

describe('isNodeHeadersDownloadFailure', () => {
  it('matches node-gyp failing to fetch the Node headers tarball', () => {
    expect(isNodeHeadersDownloadFailure(HEADERS_REFUSED)).toBe(true)
    expect(
      isNodeHeadersDownloadFailure(
        'gyp http fetch GET https://nodejs.org/download/release/v20.19.0/node-v20.19.0-headers.tar.gz attempt 1 failed with ENOTFOUND\ngyp ERR! configure error'
      )
    ).toBe(true)
  })

  it('is not the toolchain diagnosis, and does not fire on other network failures', () => {
    expect(shouldProbeBuildToolchainAfterNativeDepsFailure(HEADERS_REFUSED)).toBe(false)
    // The registry, not nodejs.org: a different remedy.
    expect(
      isNodeHeadersDownloadFailure(
        'npm error network request to https://registry.npmjs.org/node-pty failed, reason: connect ECONNREFUSED'
      )
    ).toBe(false)
    // Headers named but the build failed for another reason.
    expect(
      isNodeHeadersDownloadFailure(
        'gyp info using node-v24.12.0-headers.tar.gz\ngyp ERR! build error make failed with exit code: 2'
      )
    ).toBe(false)
    // A retried attempt that recovered, then a compile failure: not a download failure.
    expect(
      isNodeHeadersDownloadFailure(
        'gyp http fetch GET https://nodejs.org/download/release/v24.12.0/node-v24.12.0-headers.tar.gz attempt 1 failed with ECONNRESET\n' +
          'gyp http 200 https://nodejs.org/download/release/v24.12.0/node-v24.12.0-headers.tar.gz\n' +
          'gyp ERR! build error\ngyp ERR! stack Error: `make` failed with exit code: 2'
      )
    ).toBe(false)
    // A mirror answering non-2xx is a FetchError without a network code: a different remedy.
    expect(
      isNodeHeadersDownloadFailure(
        'gyp ERR! configure error\ngyp ERR! stack FetchError: 404 Not Found https://mirror/dist/v24.12.0/node-v24.12.0-headers.tar.gz'
      )
    ).toBe(false)
  })
})

describe('formatNodeHeadersDownloadError', () => {
  it('names both host remedies when the host ships no headers', () => {
    const msg = formatNodeHeadersDownloadError(HEADERS_REFUSED, null)
    expect(msg).toContain('no local headers matching its own version')
    expect(msg).toContain('<prefix>/include/node')
    expect(msg).toContain('nvm, fnm, volta, n')
    expect(msg).toContain('disturl')
    expect(msg).toContain('ECONNREFUSED')
  })

  it('reports an Orca defect, not a host problem, when headers were exported and ignored', () => {
    const msg = formatNodeHeadersDownloadError(HEADERS_REFUSED, '/usr/local')
    expect(msg).toContain('/usr/local/include/node')
    expect(msg).toContain('Orca defect')
    expect(msg).not.toContain('no local headers matching its own version')
    expect(msg).not.toContain('nvm, fnm, volta, n')
    expect(msg).toContain('ECONNREFUSED')
  })
})
