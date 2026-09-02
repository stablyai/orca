import os from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DiagnosticModule from './linux-package-install-diagnostic'

const ESC = String.fromCharCode(27)
let diagnostic: typeof DiagnosticModule

beforeEach(async () => {
  vi.resetModules()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  diagnostic = await import('./linux-package-install-diagnostic')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('redactLinuxPackageInstallText', () => {
  it('strips terminal escapes and control characters', () => {
    const text = `${ESC}[?25l${ESC}[31mdpkg:\r\n\terror\u0000${ESC}[0m${ESC}[?25h`
    expect(diagnostic.redactLinuxPackageInstallText(text, null)).toBe('dpkg: error')
  })

  it('strips string escape payloads and remaining two-byte escapes', () => {
    const BEL = String.fromCharCode(7)
    const text =
      `${ESC}]8;;https://tracker.invalid/report${BEL}dpkg${ESC}]8;;${BEL} ` +
      `${ESC}P1;2|payload${ESC}\\failed${ESC}c`
    expect(diagnostic.redactLinuxPackageInstallText(text, null)).toBe('dpkg failed')
  })

  it('replaces every cached package-path occurrence before the home directory', () => {
    const home = os.homedir()
    const packagePath = `${home}/.cache/orca-updater/Orca-1.2.3.deb`
    const text = `${packagePath} failed; retry ${packagePath}; config ${home}/.config/orca`
    expect(diagnostic.redactLinuxPackageInstallText(text, packagePath)).toBe(
      '<package> failed; retry <package>; config <home>/.config/orca'
    )
  })

  it('replaces a bare username without corrupting short names', () => {
    vi.spyOn(os, 'userInfo').mockReturnValue({ username: 'devuser' } as os.UserInfo<string>)
    expect(
      diagnostic.redactLinuxPackageInstallText('devuser is not in the sudoers file', null)
    ).toBe('<user> is not in the sudoers file')

    vi.mocked(os.userInfo).mockReturnValue({ username: 'ci' } as os.UserInfo<string>)
    expect(diagnostic.redactLinuxPackageInstallText('ci: incident in circuit', null)).toBe(
      'ci: incident in circuit'
    )
  })

  it('survives an unavailable user record', () => {
    vi.spyOn(os, 'userInfo').mockImplementation(() => {
      throw new Error('no passwd entry')
    })
    expect(diagnostic.redactLinuxPackageInstallText('dpkg: unrecoverable error', null)).toBe(
      'dpkg: unrecoverable error'
    )
  })

  it('bounds the result at 1024 characters', () => {
    expect(diagnostic.redactLinuxPackageInstallText('a'.repeat(2_000), null)).toHaveLength(1_024)
    expect(diagnostic.redactLinuxPackageInstallText('a'.repeat(1_024), null)).toHaveLength(1_024)
  })

  it('returns null when no visible text remains', () => {
    expect(diagnostic.redactLinuxPackageInstallText('', null)).toBeNull()
    expect(diagnostic.redactLinuxPackageInstallText('   \n\t ', null)).toBeNull()
    expect(diagnostic.redactLinuxPackageInstallText(`${ESC}[0m`, null)).toBeNull()
    expect(diagnostic.redactLinuxPackageInstallText(null, null)).toBeNull()
    expect(diagnostic.redactLinuxPackageInstallText(undefined, null)).toBeNull()
  })

  it('normalizes errors, objects, and primitives', () => {
    expect(diagnostic.redactLinuxPackageInstallText(new Error('pkexec failed'), null)).toBe(
      'pkexec failed'
    )
    expect(diagnostic.redactLinuxPackageInstallText({ code: 127 }, null)).toBe('{"code":127}')
    expect(diagnostic.redactLinuxPackageInstallText(127, null)).toBe('127')
  })

  it('returns null for an unserializable object', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(diagnostic.redactLinuxPackageInstallText(circular, null)).toBeNull()
  })

  it('ignores an empty package path', () => {
    expect(diagnostic.redactLinuxPackageInstallText('plain output', '')).toBe('plain output')
  })
})

describe('createUpdaterDiagnosticLogger', () => {
  it('forwards every updater level to the matching console method', () => {
    const logger = diagnostic.createUpdaterDiagnosticLogger()
    logger.info('a')
    logger.warn('b')
    logger.error('c')
    logger.debug('d')

    expect(console.info).toHaveBeenCalledWith('[autoUpdater]', 'a')
    expect(console.warn).toHaveBeenCalledWith('[autoUpdater]', 'b')
    expect(console.error).toHaveBeenCalledWith('[autoUpdater]', 'c')
    expect(console.debug).toHaveBeenCalledWith('[autoUpdater]', 'd')
  })
})
