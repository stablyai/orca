import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeSingleWindowsPathEntry } from '../../shared/windows-path-entry'
import { getVersionManagerBinPaths } from './command'

const describeWindows = describe.runIf(process.platform === 'win32')
const testRoots: string[] = []
const windowsHome = 'C:\\Users\\orca-test'
const windowsAppData = 'D:\\Profiles\\orca-test\\Roaming'
const windowsFnmDir = 'E:\\fnm-data'
const invalidWindowsDirectories: [string, string | undefined][] = [
  ['missing', undefined],
  ['empty', ''],
  ['whitespace', '   '],
  ['relative', 'relative\\directory'],
  ['root-relative', '\\root-relative\\directory'],
  ['unexpanded', '%APPDATA%\\directory'],
  ['quoted', '"D:\\quoted"'],
  ['NUL-containing', 'D:\\malformed\0directory'],
  ['PATH-delimited', 'D:\\escaped;D:\\suffix'],
  ['pipe-containing', 'D:\\invalid|directory'],
  ['stream-colon-containing', 'D:\\invalid:directory'],
  ['wildcard-containing', 'D:\\invalid*directory'],
  ['question-mark-containing', 'D:\\invalid?directory'],
  ['angle-bracket-containing', 'D:\\invalid<directory'],
  ['control-character-containing', 'D:\\invalid\u0001directory'],
  ['trailing-dot component', 'D:\\invalid.\\directory'],
  ['trailing-space component', 'D:\\invalid \\directory'],
  ['incomplete extended UNC', '\\\\?\\UNC\\server'],
  ['noncanonical extended UNC', '\\\\?\\UNC/server/share']
]
const validWindowsDirectories: [string, string][] = [
  ['drive', 'C:\\fnm'],
  ['spaces', 'C:\\Program Files\\fnm data'],
  ['Unicode', 'C:\\用户\\fnm-λ'],
  ['UNC', '\\\\server\\share\\fnm'],
  ['extended drive', '\\\\?\\C:\\very long\\fnm'],
  ['extended UNC', '\\\\?\\UNC\\server\\share\\fnm'],
  ['device', '\\\\.\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\fnm'],
  ['trailing separator', 'C:\\fnm\\']
]

function createTestRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-windows-fnm-path-'))
  testRoots.push(root)
  return root
}

function installNode(directory: string): string {
  mkdirSync(directory, { recursive: true })
  const nodePath = join(directory, 'node.exe')
  copyFileSync(process.execPath, nodePath)
  return nodePath
}

function expectNodeLaunch(paths: string[], expectedNodePath: string): void {
  const result = spawnSync(
    process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    ['/d', '/s', '/c', 'node.exe -p process.execPath'],
    {
      encoding: 'utf8',
      env: {
        ComSpec: process.env.ComSpec,
        PATHEXT: '.EXE',
        Path: paths.join(';'),
        SystemRoot: process.env.SystemRoot
      }
    }
  )

  expect(result.status, result.stderr).toBe(0)
  expect(realpathSync(result.stdout.trim()).toLowerCase()).toBe(
    realpathSync(expectedNodePath).toLowerCase()
  )
}

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Windows fnm directory selection', () => {
  it.each(validWindowsDirectories)('accepts a valid %s directory', (_label, directory) => {
    expect(normalizeSingleWindowsPathEntry(directory)).toBe(directory)
    expect(
      getVersionManagerBinPaths({
        platform: 'win32',
        homePath: windowsHome,
        env: { FNM_DIR: directory }
      })
    ).toContain(win32.join(directory, 'aliases', 'default'))
  })

  it('prefers FNM_DIR over APPDATA without a POSIX bin suffix', () => {
    const paths = getVersionManagerBinPaths({
      platform: 'win32',
      homePath: windowsHome,
      env: { APPDATA: windowsAppData, FNM_DIR: windowsFnmDir }
    })
    const fnmDefault = win32.join(windowsFnmDir, 'aliases', 'default')

    expect(paths).toContain(fnmDefault)
    expect(paths).not.toContain(win32.join(windowsAppData, 'fnm', 'aliases', 'default'))
    expect(paths).not.toContain(win32.join(fnmDefault, 'bin'))
  })

  it.each(invalidWindowsDirectories)('falls back to APPDATA for %s FNM_DIR', (_label, fnmDir) => {
    const paths = getVersionManagerBinPaths({
      platform: 'win32',
      homePath: windowsHome,
      env: { APPDATA: windowsAppData, FNM_DIR: fnmDir }
    })

    expect(paths).toContain(win32.join(windowsAppData, 'fnm', 'aliases', 'default'))
  })

  it.each(invalidWindowsDirectories)(
    'falls back to the home-derived roaming directory for %s APPDATA',
    (_label, appData) => {
      const paths = getVersionManagerBinPaths({
        platform: 'win32',
        homePath: windowsHome,
        env: { APPDATA: appData }
      })

      expect(paths).toContain(
        win32.join(windowsHome, 'AppData', 'Roaming', 'fnm', 'aliases', 'default')
      )
    }
  )

  it('preserves higher-priority non-fnm Node directories', () => {
    const paths = getVersionManagerBinPaths({
      platform: 'win32',
      homePath: windowsHome,
      env: { FNM_DIR: windowsFnmDir }
    })
    const voltaBin = join(windowsHome, '.volta', 'bin')
    const fnmDefault = win32.join(windowsFnmDir, 'aliases', 'default')

    expect(paths.indexOf(voltaBin)).toBeLessThan(paths.indexOf(fnmDefault))
  })
})

describeWindows('Windows fnm Node process launch', () => {
  it('rejects an FNM_DIR that injects a second PATH entry', () => {
    const root = createTestRoot()
    const escaped = join(root, 'escaped')
    const appData = join(root, 'AppData', 'Roaming')
    const expectedNodePath = installNode(join(appData, 'fnm', 'aliases', 'default'))
    installNode(escaped)

    const paths = getVersionManagerBinPaths({
      platform: 'win32',
      homePath: root,
      env: { APPDATA: appData, FNM_DIR: `${escaped};${join(root, 'suffix')}` }
    })

    expectNodeLaunch(paths, expectedNodePath)
    expect(paths).toContain(join(appData, 'fnm', 'aliases', 'default'))
  })

  it('rejects an APPDATA value that injects a second PATH entry', () => {
    const root = createTestRoot()
    const escaped = join(root, 'escaped')
    const expectedDefault = join(root, 'AppData', 'Roaming', 'fnm', 'aliases', 'default')
    const expectedNodePath = installNode(expectedDefault)
    installNode(escaped)

    const paths = getVersionManagerBinPaths({
      platform: 'win32',
      homePath: root,
      env: { APPDATA: `${escaped};${join(root, 'suffix')}` }
    })

    expectNodeLaunch(paths, expectedNodePath)
    expect(paths).toContain(expectedDefault)
  })

  it('launches Node from FNM_DIR instead of APPDATA', () => {
    const root = createTestRoot()
    const fnmDefault = join(root, 'configured-fnm', 'aliases', 'default')
    const appData = join(root, 'AppData', 'Roaming')
    const appDataDefault = join(appData, 'fnm', 'aliases', 'default')
    const expectedNodePath = installNode(fnmDefault)
    installNode(appDataDefault)

    const paths = getVersionManagerBinPaths({
      platform: 'win32',
      homePath: root,
      env: { APPDATA: appData, FNM_DIR: join(root, 'configured-fnm') }
    })

    expect(paths).toContain(fnmDefault)
    expect(paths).not.toContain(appDataDefault)
    expectNodeLaunch(paths, expectedNodePath)
  })

  it('launches Node from a higher-priority non-fnm directory', () => {
    const root = createTestRoot()
    const voltaBin = join(root, '.volta', 'bin')
    const expectedNodePath = installNode(voltaBin)
    const fnmDir = join(root, 'fnm')
    installNode(join(fnmDir, 'aliases', 'default'))

    const paths = getVersionManagerBinPaths({
      platform: 'win32',
      homePath: root,
      env: { FNM_DIR: fnmDir }
    })

    expect(paths.indexOf(voltaBin)).toBeLessThan(paths.indexOf(join(fnmDir, 'aliases', 'default')))
    expectNodeLaunch(paths, expectedNodePath)
  })
})
