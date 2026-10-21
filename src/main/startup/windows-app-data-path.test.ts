import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import {
  deriveWindowsAppDataPath,
  ensureWindowsAppDataPath,
  type WindowsAppDataPathHost
} from './windows-app-data-path'

const ERROR_MESSAGE = /could not find the Windows roaming AppData folder/

function createHost(
  nativeAppData: string | Error,
  switches: string[] = []
): WindowsAppDataPathHost & {
  calls: string[]
  paths: Map<string, string>
} {
  const calls: string[] = []
  const paths = new Map<string, string>()
  return {
    calls,
    paths,
    getName: () => 'orca',
    commandLine: { hasSwitch: (name) => switches.includes(name) },
    getPath: (name) => {
      calls.push(`get:${name}`)
      const overridden = paths.get(name)
      if (overridden) {
        return overridden
      }
      if (nativeAppData instanceof Error) {
        throw nativeAppData
      }
      return nativeAppData
    },
    setPath: (name, value) => {
      calls.push(`set:${name}`)
      paths.set(name, value)
    }
  }
}

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    removeTreeSync(dir)
  }
})

describe('deriveWindowsAppDataPath', () => {
  it('prefers APPDATA', () => {
    expect(
      deriveWindowsAppDataPath({
        APPDATA: 'D:\\Profiles\\me\\Roaming',
        USERPROFILE: 'C:\\Users\\me'
      })
    ).toBe('D:\\Profiles\\me\\Roaming')
  })

  it('falls back to USERPROFILE\\AppData\\Roaming when APPDATA is unset or relative', () => {
    expect(deriveWindowsAppDataPath({ USERPROFILE: 'C:\\Users\\me' })).toBe(
      'C:\\Users\\me\\AppData\\Roaming'
    )
    expect(deriveWindowsAppDataPath({ APPDATA: 'Roaming', USERPROFILE: 'C:\\Users\\me' })).toBe(
      'C:\\Users\\me\\AppData\\Roaming'
    )
  })

  it('throws a readable error when neither variable is usable', () => {
    expect(() => deriveWindowsAppDataPath({})).toThrow(ERROR_MESSAGE)
    expect(() => deriveWindowsAppDataPath({ APPDATA: ' ', USERPROFILE: '' })).toThrow(ERROR_MESSAGE)
  })
})

describe('ensureWindowsAppDataPath', () => {
  it('does nothing off Windows', () => {
    const host = createHost(new Error('unused'))
    ensureWindowsAppDataPath(host, {}, 'darwin')
    expect(host.calls).toEqual([])
  })

  it('keeps the native appData and pins userData to the path Electron would derive', () => {
    const host = createHost('C:\\Users\\me\\AppData\\Roaming')
    ensureWindowsAppDataPath(host, { APPDATA: 'D:\\ignored' }, 'win32')
    expect(host.calls).toEqual(['get:appData', 'set:userData'])
    expect(host.paths.get('userData')).toBe('C:\\Users\\me\\AppData\\Roaming\\orca')
  })

  it('leaves userData to an explicit --user-data-dir switch', () => {
    const host = createHost('C:\\Users\\me\\AppData\\Roaming', ['user-data-dir'])
    ensureWindowsAppDataPath(host, {}, 'win32')
    expect(host.calls).toEqual(['get:appData'])
  })

  it('creates and sets appData from the environment before userData when the lookup throws', () => {
    // Why a real dir: the fallback must mkdir a folder that a profile-less session never created.
    const root = mkdtempSync(join(tmpdir(), 'orca-appdata-'))
    tempDirs.push(root)
    const missingAppData = join(root, 'missing', 'Roaming')
    const host = createHost(new Error('Failed to get appData path'))

    ensureWindowsAppDataPath(host, { APPDATA: missingAppData }, 'win32')

    expect(host.calls).toEqual(['get:appData', 'set:appData', 'set:userData'])
    expect(host.paths.get('appData')).toBe(missingAppData)
    expect(host.paths.get('userData')).toBe(win32.join(missingAppData, 'orca'))
    expect(existsSync(missingAppData)).toBe(true)
  })

  it('treats an empty native appData like a failed lookup', () => {
    const host = createHost('')
    expect(() => ensureWindowsAppDataPath(host, {}, 'win32')).toThrow(ERROR_MESSAGE)
    expect(host.calls).toEqual(['get:appData'])
  })

  it('fails with a readable error, setting nothing, when both variables are missing', () => {
    const host = createHost(new Error('Failed to get appData path'))
    expect(() => ensureWindowsAppDataPath(host, {}, 'win32')).toThrow(ERROR_MESSAGE)
    expect(host.paths.size).toBe(0)
  })
})

describe('startup ordering', () => {
  it('pins Windows appData before any preflight step can resolve userData', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
      'utf8'
    )
    const body = source.slice(source.indexOf('function initializeMainProcessPreflight('))
    const ensure = body.indexOf('ensureWindowsAppDataPath(app)')
    expect(ensure).toBeGreaterThan(0)
    for (const laterStep of [
      'runProfileStateRecoveryPreflight()',
      'maybeRedirectCliLaunch(',
      'configureDevUserDataPath(',
      'configureOrcaUserDataPathEnv()',
      'startCrashpadCapture()'
    ]) {
      expect(body.indexOf(laterStep)).toBeGreaterThan(ensure)
    }
  })
})
