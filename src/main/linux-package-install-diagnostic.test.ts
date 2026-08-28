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
  it('strips ANSI escape sequences', () => {
    const text = `${ESC}[31mdpkg: error${ESC}[0m processing`
    expect(diagnostic.redactLinuxPackageInstallText(text, null)).toBe('dpkg: error processing')
  })

  it('strips ANSI sequences with private and intermediate bytes', () => {
    const text = `${ESC}[?25lworking${ESC}[?25h`
    expect(diagnostic.redactLinuxPackageInstallText(text, null)).toBe('working')
  })

  it('replaces control characters and collapses whitespace', () => {
    const text = `line one\r\n\tline\u0000two   spaced\u007f`
    expect(diagnostic.redactLinuxPackageInstallText(text, null)).toBe('line one line two spaced')
  })

  it('replaces the cached package path with a placeholder', () => {
    const packagePath = '/home/user/.cache/orca-updater/Orca-1.2.3.deb'
    const text = `dpkg: error processing ${packagePath} (--install)`
    expect(diagnostic.redactLinuxPackageInstallText(text, packagePath)).toBe(
      'dpkg: error processing <package> (--install)'
    )
  })

  it('replaces every occurrence of the package path', () => {
    const packagePath = '/tmp/orca.deb'
    const text = `${packagePath} failed; retry ${packagePath}`
    expect(diagnostic.redactLinuxPackageInstallText(text, packagePath)).toBe(
      '<package> failed; retry <package>'
    )
  })

  it('replaces the home directory with a placeholder', () => {
    const home = os.homedir()
    const text = `could not read ${home}/.config/orca/settings.json`
    expect(diagnostic.redactLinuxPackageInstallText(text, null)).toBe(
      'could not read <home>/.config/orca/settings.json'
    )
  })

  it('prefers the package placeholder for a path inside the home directory', () => {
    const home = os.homedir()
    const packagePath = `${home}/.cache/orca-updater/Orca-1.2.3.deb`
    expect(diagnostic.redactLinuxPackageInstallText(`install ${packagePath}`, packagePath)).toBe(
      'install <package>'
    )
  })

  it('replaces the bare username with a placeholder', () => {
    // Why: sudo names the user without any path around it, so the <home> rule never sees it.
    vi.spyOn(os, 'userInfo').mockReturnValue({ username: 'devuser' } as os.UserInfo<string>)
    expect(
      diagnostic.redactLinuxPackageInstallText('devuser is not in the sudoers file', null)
    ).toBe('<user> is not in the sudoers file')
  })

  it('leaves a username shorter than three characters alone', () => {
    // Short names would corrupt unrelated words.
    vi.spyOn(os, 'userInfo').mockReturnValue({ username: 'ci' } as os.UserInfo<string>)
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

  it('truncates to 1024 characters', () => {
    const result = diagnostic.redactLinuxPackageInstallText('a'.repeat(2000), null)
    expect(result).toHaveLength(1024)
  })

  it('keeps text at exactly the limit', () => {
    const result = diagnostic.redactLinuxPackageInstallText('a'.repeat(1024), null)
    expect(result).toHaveLength(1024)
  })

  it('returns null for empty and whitespace-only input', () => {
    expect(diagnostic.redactLinuxPackageInstallText('', null)).toBeNull()
    expect(diagnostic.redactLinuxPackageInstallText('   \n\t ', null)).toBeNull()
    expect(diagnostic.redactLinuxPackageInstallText(`${ESC}[0m`, null)).toBeNull()
  })

  it('returns null for null and undefined', () => {
    expect(diagnostic.redactLinuxPackageInstallText(null, null)).toBeNull()
    expect(diagnostic.redactLinuxPackageInstallText(undefined, null)).toBeNull()
  })

  it('uses the message of an Error', () => {
    expect(diagnostic.redactLinuxPackageInstallText(new Error('pkexec failed'), null)).toBe(
      'pkexec failed'
    )
  })

  it('serializes plain objects and other primitives', () => {
    expect(diagnostic.redactLinuxPackageInstallText({ code: 127 }, null)).toBe('{"code":127}')
    expect(diagnostic.redactLinuxPackageInstallText(127, null)).toBe('127')
  })

  it('returns null for an unserializable object', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(diagnostic.redactLinuxPackageInstallText(circular, null)).toBeNull()
  })

  it('strips an OSC hyperlink along with its URL payload', () => {
    const BEL = String.fromCharCode(7)
    const text = `${ESC}]8;;https://tracker.invalid/report${BEL}dpkg: error${ESC}]8;;${BEL} processing`
    expect(diagnostic.redactLinuxPackageInstallText(text, null)).toBe('dpkg: error processing')
  })

  it('strips a string-terminated DCS sequence and a two-byte escape', () => {
    const text = `${ESC}P1;2|payload${ESC}\\dpkg${ESC}c: error`
    expect(diagnostic.redactLinuxPackageInstallText(text, null)).toBe('dpkg: error')
  })

  it('ignores an empty package path', () => {
    expect(diagnostic.redactLinuxPackageInstallText('plain output', '')).toBe('plain output')
  })
})

describe('createUpdaterDiagnosticLogger', () => {
  it('retains redacted error output while capturing', () => {
    const logger = diagnostic.createUpdaterDiagnosticLogger()
    diagnostic.beginLinuxPackageInstallDiagnosticCapture('/tmp/orca.deb')
    logger.error(`${ESC}[31mpkexec: /tmp/orca.deb  not authorized${ESC}[0m`)
    expect(diagnostic.getLinuxPackageInstallDiagnostic()).toEqual({
      message: 'pkexec: <package> not authorized',
      reason: 'authentication-denied'
    })
  })

  it('ignores non-error levels', () => {
    const logger = diagnostic.createUpdaterDiagnosticLogger()
    diagnostic.beginLinuxPackageInstallDiagnosticCapture(null)
    logger.info('downloading')
    logger.warn('retrying')
    logger.debug('verbose')
    expect(diagnostic.getLinuxPackageInstallDiagnostic()).toBeNull()
  })

  it('still forwards every level to the console', () => {
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

  it('retains nothing outside a capture window', () => {
    const logger = diagnostic.createUpdaterDiagnosticLogger()
    logger.error('unrelated failure')
    expect(diagnostic.getLinuxPackageInstallDiagnostic()).toBeNull()
  })

  it('keeps the last usable error and ignores empty ones', () => {
    const logger = diagnostic.createUpdaterDiagnosticLogger()
    diagnostic.beginLinuxPackageInstallDiagnosticCapture(null)
    logger.error('first failure')
    logger.error('second failure')
    logger.error('')
    expect(diagnostic.getLinuxPackageInstallDiagnostic()).toEqual({
      message: 'second failure',
      reason: 'package-install-failed'
    })
  })

  it('hands back and clears the diagnostic when capture ends', () => {
    const logger = diagnostic.createUpdaterDiagnosticLogger()
    diagnostic.beginLinuxPackageInstallDiagnosticCapture(null)
    logger.error('request dismissed')
    expect(diagnostic.endLinuxPackageInstallDiagnosticCapture()).toEqual({
      message: 'request dismissed',
      reason: 'authentication-denied'
    })
    expect(diagnostic.getLinuxPackageInstallDiagnostic()).toBeNull()
    logger.error('later noise')
    expect(diagnostic.getLinuxPackageInstallDiagnostic()).toBeNull()
  })

  it('drops a previous attempt when a new capture begins', () => {
    const logger = diagnostic.createUpdaterDiagnosticLogger()
    diagnostic.beginLinuxPackageInstallDiagnosticCapture('/tmp/a.deb')
    logger.error('old failure')
    diagnostic.beginLinuxPackageInstallDiagnosticCapture('/tmp/b.deb')
    expect(diagnostic.getLinuxPackageInstallDiagnostic()).toBeNull()
    logger.error('new failure at /tmp/b.deb')
    expect(diagnostic.getLinuxPackageInstallDiagnostic()).toEqual({
      message: 'new failure at <package>',
      reason: 'package-install-failed'
    })
  })

  it('classifies the original output, not the redacted text', () => {
    // A user named "age" turns "agent" into "<user>nt", which would hide the missing polkit agent.
    vi.spyOn(os, 'userInfo').mockReturnValue({ username: 'age' } as os.UserInfo<string>)
    const logger = diagnostic.createUpdaterDiagnosticLogger()
    diagnostic.beginLinuxPackageInstallDiagnosticCapture(null)
    logger.error('Error executing command as another user: No authentication agent found for age.')
    expect(diagnostic.getLinuxPackageInstallDiagnostic()).toEqual({
      message:
        'Error executing command as another user: No authentication <user>nt found for <user>.',
      reason: 'authentication-agent-unavailable'
    })
  })

  it('keeps a specific verdict when a generic line follows it', () => {
    // electron-updater logs the polkit output first, then "Command failed, exited with code 126".
    const logger = diagnostic.createUpdaterDiagnosticLogger()
    diagnostic.beginLinuxPackageInstallDiagnosticCapture(null)
    logger.error('polkit-agent-helper-1: no authentication agent found')
    logger.error('Command failed, exited with code 126')
    expect(diagnostic.getLinuxPackageInstallDiagnostic()).toEqual({
      message: 'polkit-agent-helper-1: no authentication agent found',
      reason: 'authentication-agent-unavailable'
    })
  })

  it('lets a later specific line replace an earlier one', () => {
    const logger = diagnostic.createUpdaterDiagnosticLogger()
    diagnostic.beginLinuxPackageInstallDiagnosticCapture(null)
    logger.error('no authentication agent')
    logger.error('request dismissed')
    expect(diagnostic.getLinuxPackageInstallDiagnostic()).toEqual({
      message: 'request dismissed',
      reason: 'authentication-denied'
    })
  })

  it('returns null from an empty capture window', () => {
    diagnostic.beginLinuxPackageInstallDiagnosticCapture(null)
    expect(diagnostic.endLinuxPackageInstallDiagnosticCapture()).toBeNull()
  })
})

describe('classifyLinuxPackageInstallFailure', () => {
  it('reports a missing authentication agent', () => {
    for (const text of [
      'Error executing command as another user: No authentication agent found.',
      'polkit-agent-helper: agent not found',
      'polkit agent was not found'
    ]) {
      expect(diagnostic.classifyLinuxPackageInstallFailure(text)).toBe(
        'authentication-agent-unavailable'
      )
    }
  })

  it('reports a denied authentication', () => {
    for (const text of [
      'Error executing command as another user: Request dismissed',
      'polkit: Authentication failed',
      'Error executing command as another user: Not authorized',
      'Authorization failed for org.freedesktop.policykit.exec',
      'pkexec: 3 incorrect password attempts'
    ]) {
      expect(diagnostic.classifyLinuxPackageInstallFailure(text)).toBe('authentication-denied')
    }
  })

  it('prefers the agent reason when both patterns appear', () => {
    expect(
      diagnostic.classifyLinuxPackageInstallFailure(
        'No authentication agent found; authentication failed'
      )
    ).toBe('authentication-agent-unavailable')
  })

  it('falls back to a generic failure for localized output', () => {
    expect(
      diagnostic.classifyLinuxPackageInstallFailure(
        "Erreur lors de l'exécution : aucun agent d'authentification trouvé"
      )
    ).toBe('package-install-failed')
  })

  it('falls back to a generic failure for unrecognized and missing output', () => {
    expect(diagnostic.classifyLinuxPackageInstallFailure('dpkg: dependency problems')).toBe(
      'package-install-failed'
    )
    expect(diagnostic.classifyLinuxPackageInstallFailure(null)).toBe('package-install-failed')
    expect(diagnostic.classifyLinuxPackageInstallFailure('')).toBe('package-install-failed')
  })
})

describe('parseLinuxPackageInstallExitCode', () => {
  it('parses electron-updater exit-code messages', () => {
    expect(
      diagnostic.parseLinuxPackageInstallExitCode(
        new Error('Command /usr/bin/pkexec exited with code 127')
      )
    ).toBe(127)
    expect(diagnostic.parseLinuxPackageInstallExitCode('Command failed exited with code 0')).toBe(0)
  })

  it('parses a negative code and matches case-insensitively', () => {
    expect(diagnostic.parseLinuxPackageInstallExitCode('Exited With Code -1')).toBe(-1)
  })

  it('returns null when no code is present', () => {
    expect(diagnostic.parseLinuxPackageInstallExitCode(new Error('spawn ENOENT'))).toBeNull()
    expect(diagnostic.parseLinuxPackageInstallExitCode('exited with code abc')).toBeNull()
    expect(diagnostic.parseLinuxPackageInstallExitCode(null)).toBeNull()
    expect(diagnostic.parseLinuxPackageInstallExitCode({ code: 127 })).toBeNull()
  })
})
