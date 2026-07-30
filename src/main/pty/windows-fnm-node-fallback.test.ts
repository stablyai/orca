import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  shouldApplyWindowsFnmNodeFallback,
  type WindowsNodeProbe,
  withWindowsFnmNodeFallback
} from './windows-fnm-node-fallback'

const itWindows = it.runIf(process.platform === 'win32')
const tempDirectories: string[] = []

function sourceEnv(pathValue: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra }
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'path') {
      delete env[key]
    }
  }
  env.Path = pathValue
  return env
}

function createNode(directory: string): string {
  mkdirSync(directory, { recursive: true })
  const target = join(directory, 'node.exe')
  copyFileSync(process.execPath, target)
  return target
}

function normalized(pathValue: string): string {
  return win32.normalize(pathValue).toLowerCase()
}

function runNode(env: NodeJS.ProcessEnv): string {
  const result = spawnSync('node.exe', ['-p', 'process.execPath'], {
    encoding: 'utf8',
    env,
    windowsHide: true
  })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout.trim()
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Windows fnm Node child fallback', () => {
  it.each([
    ['SSH', { connectionId: 'ssh-1', isAgentLaunch: true, isWsl: false, platform: 'win32' }],
    ['WSL', { connectionId: null, isAgentLaunch: true, isWsl: true, platform: 'win32' }],
    ['bare shell', { connectionId: null, isAgentLaunch: false, isWsl: false, platform: 'win32' }],
    ['non-Windows', { connectionId: null, isAgentLaunch: true, isWsl: false, platform: 'linux' }]
  ] as const)('bypasses the %s route', (_label, route) => {
    expect(shouldApplyWindowsFnmNodeFallback(route)).toBe(false)
  })

  it('selects only a native local Windows agent launch', () => {
    expect(
      shouldApplyWindowsFnmNodeFallback({
        connectionId: null,
        isAgentLaunch: true,
        isWsl: false,
        platform: 'win32'
      })
    ).toBe(true)
  })

  it('preserves a working inherited Node and PATH byte-for-byte', async () => {
    const overlay = { Path: 'C:\\preferred;C:\\existing', FNM_DIR: 'C:\\fnm' }
    const probeNode = vi.fn<WindowsNodeProbe>().mockResolvedValue(true)

    const result = await withWindowsFnmNodeFallback(overlay, {
      homePath: 'C:\\Users\\dev',
      platform: 'win32',
      probeNode,
      sourceEnv: sourceEnv('C:\\source')
    })

    expect(result).toBe(overlay)
    expect(result?.Path).toBe('C:\\preferred;C:\\existing')
    expect(probeNode).toHaveBeenCalledTimes(1)
  })

  it('preserves an inherited uppercase PATH key when fallback is needed', async () => {
    const fnmDir = 'C:\\fnm'
    const expectedDirectory = win32.join(fnmDir, 'aliases', 'default')
    const probeNode = vi.fn<WindowsNodeProbe>(async (env) => env.PATH === expectedDirectory)

    const result = await withWindowsFnmNodeFallback(
      { PATH: 'C:\\existing', FNM_DIR: fnmDir },
      {
        homePath: 'C:\\Users\\dev',
        platform: 'win32',
        probeNode,
        sourceEnv: { Path: 'C:\\source' }
      }
    )

    expect(result?.PATH).toBe(`${expectedDirectory};C:\\existing`)
    expect(result).not.toHaveProperty('Path')
  })

  it.each([
    ['drive', 'C:\\fnm'],
    ['spaces', 'C:\\User Data\\fnm'],
    ['Unicode', 'C:\\Users\\开发者\\fnm'],
    ['UNC', '\\\\server\\share\\fnm'],
    ['trailing separator', 'C:\\fnm\\']
  ])('uses a runnable valid %s candidate', async (_label, fnmDir) => {
    const expectedDirectory = win32.join(fnmDir, 'aliases', 'default')
    const probeNode = vi.fn<WindowsNodeProbe>(async (env) => env.Path === expectedDirectory)

    const result = await withWindowsFnmNodeFallback(undefined, {
      homePath: 'C:\\Users\\dev',
      platform: 'win32',
      probeNode,
      sourceEnv: sourceEnv('C:\\Windows\\System32', { FNM_DIR: fnmDir })
    })

    expect(result?.Path?.split(';')).toEqual([expectedDirectory, 'C:\\Windows\\System32'])
    expect(probeNode).toHaveBeenCalledTimes(2)
  })

  it.each([
    'C:\\escaped;C:\\suffix',
    'C:\\invalid|component',
    '\\\\?\\C:\\fnm',
    '\\\\.\\pipe\\fnm',
    'relative\\fnm'
  ])('ignores a malformed candidate without changing PATH: %s', async (fnmDir) => {
    const overlay = { Path: 'C:\\Windows\\System32', FNM_DIR: fnmDir }
    const probeNode = vi.fn<WindowsNodeProbe>().mockResolvedValue(false)

    const result = await withWindowsFnmNodeFallback(overlay, {
      homePath: 'C:\\missing-home',
      platform: 'win32',
      probeNode,
      sourceEnv: sourceEnv('C:\\source', { APPDATA: 'relative\\appdata' })
    })

    expect(result).toBe(overlay)
    expect(result?.Path).toBe('C:\\Windows\\System32')
  })

  it('ignores a candidate whose node.exe cannot run', async () => {
    const overlay = { Path: 'C:\\Windows\\System32', FNM_DIR: 'C:\\missing-fnm' }
    const probeNode = vi.fn<WindowsNodeProbe>().mockResolvedValue(false)

    const result = await withWindowsFnmNodeFallback(overlay, {
      homePath: 'C:\\Users\\dev',
      platform: 'win32',
      probeNode,
      sourceEnv: sourceEnv('C:\\source')
    })

    expect(result).toBe(overlay)
    expect(probeNode).toHaveBeenCalledTimes(2)
  })

  it('filters unsafe home-derived entries before the executable probe', async () => {
    const overlay = { Path: 'C:\\Windows\\System32' }
    const probedPaths: string[] = []
    const probeNode = vi.fn<WindowsNodeProbe>(async (env) => {
      probedPaths.push(env.Path ?? '')
      return false
    })

    const result = await withWindowsFnmNodeFallback(overlay, {
      homePath: 'C:\\escaped;C:\\suffix',
      platform: 'win32',
      probeNode,
      sourceEnv: { Path: 'C:\\source' }
    })

    expect(result).toBe(overlay)
    expect(probedPaths.every((pathValue) => !pathValue.includes('escaped;'))).toBe(true)
    expect(probeNode).toHaveBeenCalledTimes(1)
  })

  it('does not probe or mutate non-Windows environments', async () => {
    const overlay = { PATH: '/usr/bin' }
    const probeNode = vi.fn<WindowsNodeProbe>().mockResolvedValue(false)

    const result = await withWindowsFnmNodeFallback(overlay, {
      platform: 'linux',
      probeNode
    })

    expect(result).toBe(overlay)
    expect(probeNode).not.toHaveBeenCalled()
  })
})

describe('native Windows fnm Node child fallback', () => {
  itWindows('keeps a real working inherited node.exe ahead of fnm', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-fnm-inherited-'))
    tempDirectories.push(root)
    const inheritedDirectory = join(root, 'inherited')
    const inheritedNode = createNode(inheritedDirectory)
    const fnmRoot = join(root, 'fnm')
    createNode(join(fnmRoot, 'aliases', 'default'))
    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const overlay = { Path: `${system32};${inheritedDirectory}`, FNM_DIR: fnmRoot }

    const result = await withWindowsFnmNodeFallback(overlay, {
      sourceEnv: sourceEnv(overlay.Path)
    })

    expect(result).toBe(overlay)
    expect(normalized(runNode(sourceEnv(result?.Path ?? '')))).toBe(normalized(inheritedNode))
  })

  itWindows('adds a validated fnm default for real child and cmd.exe lookup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-fnm-child-'))
    tempDirectories.push(root)
    const fnmRoot = join(root, 'fnm with 空格')
    const fnmNode = createNode(join(fnmRoot, 'aliases', 'default'))
    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const overlay = { Path: system32, FNM_DIR: fnmRoot }
    const disabledEnv = sourceEnv(system32)
    const disabledDirect = spawnSync('node.exe', ['--version'], {
      env: disabledEnv,
      windowsHide: true
    })
    const disabledCmd = spawnSync(
      process.env.ComSpec ?? join(system32, 'cmd.exe'),
      ['/d', '/s', '/c', 'node.exe --version'],
      { env: disabledEnv, windowsHide: true }
    )

    expect(disabledDirect.status).not.toBe(0)
    expect(disabledCmd.status).not.toBe(0)

    const result = await withWindowsFnmNodeFallback(overlay, {
      homePath: join(root, 'empty-home'),
      sourceEnv: sourceEnv(system32)
    })
    const childEnv = sourceEnv(result?.Path ?? '')
    const cmdResult = spawnSync(
      process.env.ComSpec ?? join(system32, 'cmd.exe'),
      ['/d', '/s', '/c', 'node.exe -p process.execPath'],
      { encoding: 'utf8', env: childEnv, windowsHide: true }
    )

    expect(result?.Path?.split(';')[0]).toBe(win32.join(fnmRoot, 'aliases', 'default'))
    expect(normalized(runNode(childEnv))).toBe(normalized(fnmNode))
    expect(cmdResult.status, cmdResult.stderr).toBe(0)
    expect(normalized(cmdResult.stdout.trim())).toBe(normalized(fnmNode))
  })

  itWindows('accepts an fnm default directory junction after executing its node.exe', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-fnm-junction-'))
    tempDirectories.push(root)
    const fnmRoot = join(root, 'fnm')
    const versionDirectory = join(fnmRoot, 'node-versions', 'v22', 'installation')
    const versionNode = createNode(versionDirectory)
    const defaultDirectory = join(fnmRoot, 'aliases', 'default')
    mkdirSync(join(fnmRoot, 'aliases'), { recursive: true })
    symlinkSync(versionDirectory, defaultDirectory, 'junction')
    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')

    const result = await withWindowsFnmNodeFallback(
      { Path: system32, FNM_DIR: fnmRoot },
      { homePath: join(root, 'empty-home'), sourceEnv: sourceEnv(system32) }
    )
    const resolvedNode = normalized(runNode(sourceEnv(result?.Path ?? '')))

    expect(result?.Path?.split(';')).toEqual([defaultDirectory, system32])
    expect([normalized(versionNode), normalized(join(defaultDirectory, 'node.exe'))]).toContain(
      resolvedNode
    )
  })

  itWindows('leaves PATH unchanged when the selected fnm directory does not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-fnm-missing-'))
    tempDirectories.push(root)
    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const overlay = { Path: system32, FNM_DIR: join(root, 'missing') }

    const result = await withWindowsFnmNodeFallback(overlay, {
      homePath: join(root, 'empty-home'),
      sourceEnv: sourceEnv(system32)
    })

    expect(result).toBe(overlay)
    expect(result?.Path).toBe(system32)
  })

  itWindows('preserves a runnable inherited non-fnm Node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-node-fallback-'))
    tempDirectories.push(root)
    const fallbackDirectory = join(root, 'inherited-node')
    const fallbackNode = createNode(fallbackDirectory)
    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    const overlay = {
      Path: `${system32};${fallbackDirectory}`,
      FNM_DIR: join(root, 'missing-fnm')
    }

    const result = await withWindowsFnmNodeFallback(overlay, {
      homePath: root,
      sourceEnv: sourceEnv(system32)
    })

    expect(result).toBe(overlay)
    expect(result?.Path?.split(';')).toEqual([system32, fallbackDirectory])
    expect(normalized(runNode(sourceEnv(result?.Path ?? '')))).toBe(normalized(fallbackNode))
  })
})
