import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isCloseAppProcess,
  isTooBroadInstallLocation,
  isUnexpandedNsisValue,
  mapPreviousUninstallerOutcome,
  parseUninstallExecutable,
  resolveNsisUpgradeState,
  sanitizeInstallLocation,
  shouldReportAppCannotBeClosed
} from '../nsis/upgrade-install-state.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const DEFAULT_DIR = 'C:\\Users\\a\\AppData\\Local\\Programs\\Orca'
const UNINSTALL =
  '"C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall Orca.exe" /currentuser'
const SPACE_DIR = 'C:\\Users\\a\\AppData\\Local\\Programs\\Orca App'
const SPACE_UNINSTALL = `"${SPACE_DIR}\\Uninstall Orca.exe" /currentuser`
const CUSTOM_DIR = 'D:\\Apps\\Orca'
const CUSTOM_UNINSTALL = `"${CUSTOM_DIR}\\Uninstall Orca.exe" /currentuser`

function existsAt(dirSet) {
  const dirs = new Set(dirSet.map((value) => value.toLowerCase()))
  return (dir) => dirs.has(String(dir).toLowerCase())
}

function existsExe(exeSet) {
  const exes = new Set(exeSet.map((value) => value.toLowerCase()))
  return (exe) => exes.has(String(exe).toLowerCase())
}

describe('NSIS upgrade persisted metadata', () => {
  it('rejects the literal $installDir orphan and recovers from the uninstaller path', () => {
    expect(isUnexpandedNsisValue('$installDir')).toBe(true)
    expect(sanitizeInstallLocation('$installDir')).toBeNull()

    const state = resolveNsisUpgradeState({
      installLocation: '$installDir',
      uninstallString: UNINSTALL,
      defaultInstallDir: DEFAULT_DIR,
      pathHasAppExecutable: existsAt([DEFAULT_DIR]),
      uninstallExecutableExists: existsExe([
        'C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall Orca.exe'
      ])
    })

    expect(state.instDir).toBe(DEFAULT_DIR)
    expect(state.recoveredFromUninstaller).toBe(true)
    expect(state.runPreviousUninstaller).toBe(true)
    expect(state.repairInstallLocation).toBe(true)
    expect(state.installLocationToWrite).toBe(DEFAULT_DIR)
    expect(state.discardUninstallString).toBe(false)
  })

  it('skips the previous uninstaller when UninstallString itself contains $installDir', () => {
    const state = resolveNsisUpgradeState({
      installLocation: '$installDir',
      uninstallString: '"$installDir\\Uninstall Orca.exe" /currentuser',
      defaultInstallDir: DEFAULT_DIR,
      uninstallExecutableExists: () => false
    })

    expect(state.instDir).toBe(DEFAULT_DIR)
    expect(state.runPreviousUninstaller).toBe(false)
    expect(state.discardUninstallString).toBe(true)
  })

  it('does not treat a drive-root InstallLocation as $INSTDIR', () => {
    expect(isTooBroadInstallLocation('C:\\')).toBe(true)
    expect(sanitizeInstallLocation('C:\\')).toBeNull()

    const state = resolveNsisUpgradeState({
      installLocation: 'C:\\',
      uninstallString: UNINSTALL,
      defaultInstallDir: DEFAULT_DIR,
      pathHasAppExecutable: existsAt([DEFAULT_DIR]),
      uninstallExecutableExists: existsExe([
        'C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall Orca.exe'
      ])
    })

    expect(state.instDir).toBe(DEFAULT_DIR)
    expect(state.recoveredFromUninstaller).toBe(true)
  })

  it('does not keep userData Local\\Orca as the install dir when it has no app exe', () => {
    expect(sanitizeInstallLocation('C:\\Users\\a\\AppData\\Local\\Orca')).toBeNull()
    expect(sanitizeInstallLocation('C:\\Users\\a\\AppData\\Roaming\\Orca')).toBeNull()

    const state = resolveNsisUpgradeState({
      installLocation: 'C:\\Users\\a\\AppData\\Local\\Orca',
      uninstallString: UNINSTALL,
      defaultInstallDir: DEFAULT_DIR,
      pathHasAppExecutable: existsAt([DEFAULT_DIR]),
      uninstallExecutableExists: existsExe([
        'C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall Orca.exe'
      ])
    })

    expect(state.instDir).toBe(DEFAULT_DIR)
    expect(state.recoveredFromUninstaller).toBe(true)
    expect(state.installLocationToWrite).toBe(DEFAULT_DIR)
  })

  it('rejects /D= or an uninstaller parent that is userData so _?= cannot target it', () => {
    const userData = 'C:\\Users\\a\\AppData\\Local\\Orca'
    const state = resolveNsisUpgradeState({
      installLocation: userData,
      uninstallString: `"${userData}\\Uninstall Orca.exe" /currentuser`,
      defaultInstallDir: DEFAULT_DIR,
      commandLineInstallDir: userData,
      uninstallExecutableExists: existsExe([`${userData}\\Uninstall Orca.exe`])
    })

    expect(state.instDir).toBe(DEFAULT_DIR)
    expect(state.runPreviousUninstaller).toBe(false)
    expect(state.installLocationToWrite).toBe(DEFAULT_DIR)
    expect(state.discardUninstallString).toBe(true)
  })

  it('honors a well-formed /D= override even when registry metadata is poisoned', () => {
    const isolated = 'C:\\OrcaE2E'
    const state = resolveNsisUpgradeState({
      installLocation: '$installDir',
      uninstallString: '"$installDir\\Uninstall Orca.exe" /currentuser',
      defaultInstallDir: DEFAULT_DIR,
      commandLineInstallDir: isolated
    })

    expect(state.instDir).toBe(isolated)
    expect(state.runPreviousUninstaller).toBe(false)
    expect(state.installLocationToWrite).toBeNull()
  })

  it('does not persist /D= over a valid previous InstallLocation', () => {
    const state = resolveNsisUpgradeState({
      installLocation: DEFAULT_DIR,
      uninstallString: UNINSTALL,
      defaultInstallDir: DEFAULT_DIR,
      commandLineInstallDir: CUSTOM_DIR,
      pathHasAppExecutable: existsAt([DEFAULT_DIR]),
      uninstallExecutableExists: existsExe([
        'C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall Orca.exe'
      ])
    })

    expect(state.instDir).toBe(CUSTOM_DIR)
    expect(state.runPreviousUninstaller).toBe(true)
    expect(state.installLocationToWrite).toBeNull()
    expect(state.repairInstallLocation).toBe(false)
  })

  it('writes the recovered old dir, not /D=, when InstallLocation is poisoned', () => {
    const state = resolveNsisUpgradeState({
      installLocation: '$installDir',
      uninstallString: UNINSTALL,
      defaultInstallDir: DEFAULT_DIR,
      commandLineInstallDir: CUSTOM_DIR,
      uninstallExecutableExists: existsExe([
        'C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall Orca.exe'
      ])
    })

    expect(state.instDir).toBe(CUSTOM_DIR)
    expect(state.installLocationToWrite).toBe(DEFAULT_DIR)
    expect(state.runPreviousUninstaller).toBe(true)
  })

  it('ignores a too-broad /D= and keeps a valid registry install dir', () => {
    const state = resolveNsisUpgradeState({
      installLocation: CUSTOM_DIR,
      uninstallString: '',
      defaultInstallDir: DEFAULT_DIR,
      commandLineInstallDir: 'C:\\Users\\a\\AppData\\Local',
      pathHasAppExecutable: existsAt([CUSTOM_DIR])
    })

    expect(state.instDir).toBe(CUSTOM_DIR)
    expect(state.runPreviousUninstaller).toBe(false)
  })

  it('rejects a too-broad /D= and falls back to the default or uninstaller', () => {
    expect(sanitizeInstallLocation('C:\\Users\\a\\AppData\\Local')).toBeNull()
    expect(sanitizeInstallLocation('C:\\\\')).toBeNull()

    const state = resolveNsisUpgradeState({
      installLocation: '',
      uninstallString: '',
      defaultInstallDir: DEFAULT_DIR,
      commandLineInstallDir: 'C:\\Users\\a\\AppData\\Local'
    })

    expect(state.instDir).toBe(DEFAULT_DIR)
  })

  it('keeps a valid existing install location', () => {
    const state = resolveNsisUpgradeState({
      installLocation: DEFAULT_DIR,
      uninstallString: UNINSTALL,
      defaultInstallDir: DEFAULT_DIR,
      pathHasAppExecutable: existsAt([DEFAULT_DIR]),
      uninstallExecutableExists: existsExe([
        'C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall Orca.exe'
      ])
    })

    expect(state.instDir).toBe(DEFAULT_DIR)
    expect(state.runPreviousUninstaller).toBe(true)
    expect(state.repairInstallLocation).toBe(false)
    expect(state.installLocationToWrite).toBeNull()
    expect(state.discardUninstallString).toBe(false)
  })

  it('recovers a custom install dir from a valid uninstaller when InstallLocation is poisoned', () => {
    const state = resolveNsisUpgradeState({
      installLocation: '$installDir',
      uninstallString: CUSTOM_UNINSTALL,
      defaultInstallDir: DEFAULT_DIR,
      uninstallExecutableExists: existsExe([`${CUSTOM_DIR}\\Uninstall Orca.exe`])
    })

    expect(state.instDir).toBe(CUSTOM_DIR)
    expect(state.recoveredFromUninstaller).toBe(true)
    expect(state.runPreviousUninstaller).toBe(true)
    expect(state.installLocationToWrite).toBe(CUSTOM_DIR)
    expect(state.discardUninstallString).toBe(false)
  })

  it('rejects relative and unquoted-garbage InstallLocation values', () => {
    expect(sanitizeInstallLocation('Programs\\Orca')).toBeNull()
    expect(sanitizeInstallLocation('\\\\server\\share\\Orca')).toBeNull()
    expect(sanitizeInstallLocation('"C:\\Users\\a\\AppData\\Local\\Programs\\Orca"')).toBeNull()
    expect(sanitizeInstallLocation('C:Orca')).toBeNull()
    expect(sanitizeInstallLocation('C:/Users/a/AppData/Local')).toBeNull()
  })

  it('strips trailing slashes so close-app prefix matching stays exact', () => {
    expect(sanitizeInstallLocation(`${DEFAULT_DIR}\\`)).toBe(DEFAULT_DIR)
    expect(sanitizeInstallLocation(`${SPACE_DIR}\\\\`)).toBe(SPACE_DIR)
  })

  it('preserves a path that contains spaces', () => {
    expect(sanitizeInstallLocation(SPACE_DIR)).toBe(SPACE_DIR)
    expect(parseUninstallExecutable(SPACE_UNINSTALL)).toBe(`${SPACE_DIR}\\Uninstall Orca.exe`)

    const state = resolveNsisUpgradeState({
      installLocation: SPACE_DIR,
      uninstallString: SPACE_UNINSTALL,
      defaultInstallDir: DEFAULT_DIR,
      pathHasAppExecutable: existsAt([SPACE_DIR]),
      uninstallExecutableExists: existsExe([`${SPACE_DIR}\\Uninstall Orca.exe`])
    })

    expect(state.instDir).toBe(SPACE_DIR)
    expect(state.runPreviousUninstaller).toBe(true)
    expect(state.discardUninstallString).toBe(false)
  })

  it('parses quoted and unquoted UninstallString values', () => {
    expect(parseUninstallExecutable(UNINSTALL)).toBe(
      'C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall Orca.exe'
    )
    expect(
      parseUninstallExecutable('C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall.exe /S')
    ).toBe('C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall.exe')
    expect(parseUninstallExecutable('"$installDir\\Uninstall Orca.exe" /currentuser')).toBe(
      '$installDir\\Uninstall Orca.exe'
    )
    expect(parseUninstallExecutable('')).toBeNull()
    expect(parseUninstallExecutable('/currentuser')).toBeNull()
  })

  it('is idempotent after a successful repair', () => {
    const repaired = resolveNsisUpgradeState({
      installLocation: '$installDir',
      uninstallString: UNINSTALL,
      defaultInstallDir: DEFAULT_DIR,
      pathHasAppExecutable: existsAt([DEFAULT_DIR]),
      uninstallExecutableExists: existsExe([
        'C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall Orca.exe'
      ])
    })

    const again = resolveNsisUpgradeState({
      installLocation: repaired.instDir,
      uninstallString: UNINSTALL,
      defaultInstallDir: DEFAULT_DIR,
      pathHasAppExecutable: existsAt([repaired.instDir]),
      uninstallExecutableExists: existsExe([
        'C:\\Users\\a\\AppData\\Local\\Programs\\Orca\\Uninstall Orca.exe'
      ])
    })

    expect(again.instDir).toBe(DEFAULT_DIR)
    expect(again.repairInstallLocation).toBe(false)
    expect(again.installLocationToWrite).toBeNull()
    expect(again.discardUninstallString).toBe(false)
    expect(again.runPreviousUninstaller).toBe(true)
    expect(again.recoveredFromUninstaller).toBe(false)
  })

  it('uses the per-user default on a clean install with empty registry metadata', () => {
    const state = resolveNsisUpgradeState({
      installLocation: '',
      uninstallString: '',
      defaultInstallDir: DEFAULT_DIR
    })

    expect(state.instDir).toBe(DEFAULT_DIR)
    expect(state.runPreviousUninstaller).toBe(false)
    expect(state.discardUninstallString).toBe(false)
    expect(state.installLocationToWrite).toBe(DEFAULT_DIR)
    expect(state.recoveredFromUninstaller).toBe(false)
  })
})

describe('NSIS close-app targeting', () => {
  it('closes only Orca.exe under the sanitized install dir', () => {
    expect(
      isCloseAppProcess({
        processPath: `${DEFAULT_DIR}\\Orca.exe`,
        instDir: DEFAULT_DIR
      })
    ).toBe(true)
    expect(
      isCloseAppProcess({
        processPath: `${DEFAULT_DIR}\\resources\\bin\\orca.exe`,
        instDir: DEFAULT_DIR
      })
    ).toBe(true)
    expect(
      isCloseAppProcess({
        processPath: 'C:\\Users\\a\\AppData\\Local\\Orca\\daemon-host\\orca-terminal-daemon.exe',
        instDir: DEFAULT_DIR,
        imageName: 'orca-terminal-daemon.exe'
      })
    ).toBe(false)
    expect(
      isCloseAppProcess({
        processPath: 'C:\\Other\\Orca.exe',
        instDir: DEFAULT_DIR
      })
    ).toBe(false)
    expect(
      isCloseAppProcess({
        processPath: 'C:\\Windows\\explorer.exe',
        instDir: 'C:\\'
      })
    ).toBe(false)
    expect(
      isCloseAppProcess({
        processPath: `${DEFAULT_DIR}\\Orca.exe`,
        instDir: '$installDir'
      })
    ).toBe(false)
    expect(
      isCloseAppProcess({
        processPath: `${SPACE_DIR}\\Orca.exe`,
        instDir: SPACE_DIR
      })
    ).toBe(true)
  })

  it('does not report cannot-close when the main exe is already gone', () => {
    expect(
      shouldReportAppCannotBeClosed({
        remainingProcessPaths: [
          'C:\\Users\\a\\AppData\\Local\\Orca\\daemon-host\\orca-terminal-daemon.exe'
        ],
        instDir: DEFAULT_DIR
      })
    ).toBe(false)
    expect(
      shouldReportAppCannotBeClosed({
        remainingProcessPaths: [`${DEFAULT_DIR}\\Orca.exe`],
        instDir: DEFAULT_DIR
      })
    ).toBe(true)
    expect(
      shouldReportAppCannotBeClosed({
        remainingProcessPaths: [`${DEFAULT_DIR}\\Orca.exe`],
        instDir: '$installDir'
      })
    ).toBe(false)
  })
})

describe('previous-uninstaller outcome', () => {
  it('never maps a missing or failed old uninstaller to cannot-close', () => {
    expect(
      mapPreviousUninstallerOutcome({
        ran: false,
        exitCode: 2,
        uninstallStringUsable: false
      })
    ).toEqual({ abortInstaller: false, reportCannotBeClosed: false })
    expect(
      mapPreviousUninstallerOutcome({
        ran: true,
        exitCode: 2,
        uninstallStringUsable: true
      })
    ).toEqual({ abortInstaller: false, reportCannotBeClosed: false })
    expect(
      mapPreviousUninstallerOutcome({
        ran: true,
        exitCode: 0,
        uninstallStringUsable: true
      })
    ).toEqual({ abortInstaller: false, reportCannotBeClosed: false })
  })
})

describe('disposable filesystem upgrade fixtures', () => {
  it('resolves real temp install and uninstaller files without touching the live install', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-nsis-upgrade-'))
    try {
      const installDir = join(root, 'Programs', 'Orca App')
      const userData = join(root, 'Local', 'Orca')
      await mkdir(installDir, { recursive: true })
      await mkdir(userData, { recursive: true })
      await writeFile(join(installDir, 'Orca.exe'), '', 'utf8')
      await writeFile(join(installDir, 'Uninstall Orca.exe'), '', 'utf8')

      const uninstallExe = join(installDir, 'Uninstall Orca.exe')
      const state = resolveNsisUpgradeState({
        installLocation: userData,
        uninstallString: `"${uninstallExe}" /currentuser`,
        defaultInstallDir: join(root, 'Programs', 'Orca'),
        pathHasAppExecutable: (dir) => dir.toLowerCase() === installDir.toLowerCase(),
        uninstallExecutableExists: (exe) => exe.toLowerCase() === uninstallExe.toLowerCase()
      })

      expect(state.instDir.toLowerCase()).toBe(installDir.toLowerCase())
      expect(state.recoveredFromUninstaller).toBe(true)
      expect(state.runPreviousUninstaller).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('disposable HKCU registry views', () => {
  it.skipIf(process.platform !== 'win32')(
    'sees the same disposable HKCU value in 32-bit and 64-bit views',
    () => {
      const key = 'HKCU\\Software\\OrcaNsisUpgradeReview-STA3956'
      const value = 'C:\\Temp\\OrcaNsisDisposable'
      try {
        execFileSync('reg.exe', ['add', key, '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', value, '/f'], {
          stdio: 'pipe'
        })
        const query = (view) =>
          execFileSync('reg.exe', ['query', key, '/v', 'InstallLocation', view], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe']
          })
        expect(query('/reg:32')).toContain(value)
        expect(query('/reg:64')).toContain(value)
      } finally {
        try {
          execFileSync('reg.exe', ['delete', key, '/f'], { stdio: 'pipe' })
        } catch {
          // Key is disposable; ignore a missing-key cleanup race.
        }
      }
    }
  )
})

describe('NSIS hook contract', () => {
  it('ships customInit and uninstaller-check hooks that reject $installDir', async () => {
    const nsh = await readFile(join(REPO_ROOT, 'config/nsis/upgrade-install-state.nsh'), 'utf8')
    const hooks = await readFile(join(REPO_ROOT, 'config/nsis/installer-hooks.nsh'), 'utf8')

    expect(hooks).toContain('!include "daemon-host-uninstall.nsh"')
    expect(hooks).toContain('!include "upgrade-install-state.nsh"')
    expect(hooks).not.toContain('!macro customCheckAppRunning')
    expect(nsh).toContain('!macro customInit')
    expect(nsh).not.toContain('!macro customCheckAppRunning')
    expect(nsh).toContain('!macro customUnInstallCheck')
    expect(nsh).toContain('!macro nsisUpgradeParseUninstallExe')
    expect(nsh).toContain('!macro nsisUpgradeParentDir')
    expect(nsh).toContain('!insertmacro nsisUpgradeParentDir $R3 $R4')
    expect(nsh).toContain('StrCpy $INSTDIR $R4')
    expect(nsh).toContain('ReadRegStr $R7 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation')
    expect(nsh).toContain('StrCpy $INSTDIR $R7')
    expect(nsh).toContain('DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" UninstallString')
    expect(nsh).toContain('WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation "$R4"')
    expect(nsh).toMatch(/\$1 == "\$\$"/)
    expect(nsh).toContain('${FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
    expect(nsh).toContain('${FileExists} "$R3"')
    expect(nsh).toContain('StrCpy $INSTDIR $INSTDIR $R5')
    expect(nsh).toContain('\\AppData\\Local')
    expect(nsh).toContain('\\Users')
    expect(nsh).toContain('StrCpy $1 $0 "" -19')
    expect(nsh).toContain('\\AppData\\Local\\Orca')
    expect(nsh).toContain('StrCpy $1 $0 "" -21')
    expect(nsh).toContain('\\AppData\\Roaming\\Orca')
    expect(nsh).not.toContain('MessageBox')
    expect(nsh).not.toContain('StartsWith')
    expect(nsh).not.toContain('HKLM')
    expect(nsh).not.toContain('HKEY_LOCAL_MACHINE')

    const builderConfig = await readFile(
      join(REPO_ROOT, 'config/electron-builder.config.cjs'),
      'utf8'
    )
    expect(builderConfig).toContain("resolve(__dirname, 'nsis', 'installer-hooks.nsh')")
    expect(builderConfig).not.toMatch(
      /include:\s*resolve\(__dirname,\s*'nsis',\s*'daemon-host-uninstall\.nsh'\)/
    )
  })

  it('keeps real-uninstall daemon cleanup and uses only disposable test paths', async () => {
    const daemon = await readFile(join(REPO_ROOT, 'config/nsis/daemon-host-uninstall.nsh'), 'utf8')
    expect(daemon).toContain('!macro customUnInstall')
    expect(daemon).not.toContain('!macro customCheckAppRunning')
    expect(daemon).toContain('${isUpdated}')
    expect(daemon).toContain('orca-terminal-daemon.exe')
    expect(daemon).toContain('$LOCALAPPDATA\\Orca\\daemon-host')

    const source = await readFile(new URL(import.meta.url), 'utf8')
    expect(source).toContain('orca-nsis-upgrade-')
    expect(source).toContain('tmpdir()')
  })
})
