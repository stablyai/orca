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
})
