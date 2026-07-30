import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, win32 } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeSingleWindowsPathEntry } from '../../shared/windows-path-entry'
import { getVersionManagerBinPaths, resolveCliCommand } from './command'

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
  ['reserved DOS component', 'D:\\NUL.txt\\directory'],
  ['named pipe namespace', '\\\\.\\pipe\\orca-fnm'],
  ['extended drive namespace', '\\\\?\\C:\\fnm'],
  ['extended UNC namespace', '\\\\?\\UNC\\server\\share\\fnm'],
  ['extended volume namespace', '\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\fnm'],
  ['GLOBALROOT namespace', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\fnm'],
  ['incomplete extended UNC', '\\\\?\\UNC\\server'],
  ['noncanonical extended UNC', '\\\\?\\UNC/server/share']
]
const validWindowsDirectories: [string, string][] = [
  ['drive', 'C:\\fnm'],
  ['spaces', 'C:\\Program Files\\fnm data'],
  ['Unicode', 'C:\\用户\\fnm-λ'],
  ['UNC', '\\\\server\\share\\fnm'],
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

function getNodeLaunchEnvironment(paths: string[]): NodeJS.ProcessEnv {
  return {
    ComSpec: process.env.ComSpec,
    PATHEXT: '.EXE',
    Path: paths.join(';'),
    SystemRoot: process.env.SystemRoot
  }
}

function expectReportedNodePath(output: string, expectedNodePath: string): void {
  if (expectedNodePath.startsWith('\\\\.\\')) {
    expect(output.trim().toLowerCase()).toBe(expectedNodePath.toLowerCase())
    return
  }
  expect(realpathSync(output.trim()).toLowerCase()).toBe(
    realpathSync(expectedNodePath).toLowerCase()
  )
}

function expectCmdNodeLaunch(paths: string[], expectedNodePath: string): void {
  const result = spawnSync(
    process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
    ['/d', '/s', '/c', 'node.exe -p process.execPath'],
    {
      encoding: 'utf8',
      env: getNodeLaunchEnvironment(paths)
    }
  )

  expect(result.status, result.stderr).toBe(0)
  expectReportedNodePath(result.stdout, expectedNodePath)
}

function expectDirectNodeLaunch(paths: string[], expectedNodePath: string): void {
  const result = spawnSync('node.exe', ['-p', 'process.execPath'], {
    encoding: 'utf8',
    env: getNodeLaunchEnvironment(paths)
  })

  expect(result.error, result.stderr).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  expectReportedNodePath(result.stdout, expectedNodePath)
}

function toExtendedVolumePath(localPath: string): string {
  const driveRoot = parse(localPath).root
  const volumeRoot = execFileSync('mountvol.exe', [driveRoot, '/L'], { encoding: 'utf8' }).trim()
  return `${volumeRoot}${localPath.slice(driveRoot.length)}`
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

  it('keeps the bare Node fallback when no safe installation exists', () => {
    expect(
      resolveCliCommand('node', {
        platform: 'win32',
        pathEnv: '',
        homePath: windowsHome,
        env: { FNM_DIR: 'C:\\NUL.txt', APPDATA: '\\\\.\\pipe\\orca-fnm' }
      })
    ).toBe('node')
  })
})

describeWindows('Windows fnm Node process launch', () => {
  it.each([
    ['reserved DOS component', 'NUL.txt'],
    ['named pipe namespace', '\\\\.\\pipe\\orca-fnm'],
    ['extended drive namespace', '\\\\?\\C:\\fnm'],
    ['extended UNC namespace', '\\\\?\\UNC\\server\\share\\fnm'],
    ['GLOBALROOT namespace', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\fnm']
  ])('rejects %s before launching a child from PATH', (_label, configuredFnmDir) => {
    const root = createTestRoot()
    const appData = join(root, 'AppData', 'Roaming')
    const expectedNodePath = installNode(join(appData, 'fnm', 'aliases', 'default'))
    const fnmDir = configuredFnmDir === 'NUL.txt' ? join(root, configuredFnmDir) : configuredFnmDir

    const paths = getVersionManagerBinPaths({
      platform: 'win32',
      homePath: root,
      env: { APPDATA: appData, FNM_DIR: fnmDir }
    })

    expect(paths).not.toContain(win32.join(fnmDir, 'aliases', 'default'))
    expectCmdNodeLaunch(paths, expectedNodePath)
  })

  it('rejects an extended volume path while preserving volume device lookup', () => {
    const root = createTestRoot()
    const fnmDir = join(root, 'configured-fnm')
    installNode(join(fnmDir, 'aliases', 'default'))
    const expectedNodePath = installNode(join(root, '.bun', 'bin'))
    const extendedFnmDir = toExtendedVolumePath(fnmDir)
    const deviceFnmDir = extendedFnmDir.replace('\\\\?\\', '\\\\.\\')

    const paths = getVersionManagerBinPaths({
      platform: 'win32',
      homePath: root,
      env: { FNM_DIR: extendedFnmDir }
    })

    expect(paths).not.toContain(win32.join(extendedFnmDir, 'aliases', 'default'))
    expect(paths.indexOf(join(root, '.bun', 'bin'))).toBeGreaterThan(0)
    expectDirectNodeLaunch(paths, expectedNodePath)

    const devicePaths = getVersionManagerBinPaths({
      platform: 'win32',
      homePath: root,
      env: { FNM_DIR: deviceFnmDir }
    })
    expect(devicePaths).toContain(win32.join(deviceFnmDir, 'aliases', 'default'))
    const deviceNodePath = win32.join(deviceFnmDir, 'aliases', 'default', 'node.exe')
    expectDirectNodeLaunch(devicePaths, deviceNodePath)
    expectCmdNodeLaunch(devicePaths, deviceNodePath)
  })

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

    expectCmdNodeLaunch(paths, expectedNodePath)
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

    expectCmdNodeLaunch(paths, expectedNodePath)
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
    expectCmdNodeLaunch(paths, expectedNodePath)
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
    expectCmdNodeLaunch(paths, expectedNodePath)
  })
})
