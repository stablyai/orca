import { win32 as pathWin32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveWindowsPowerShellSpawnChain } from './powershell-executable'
import { forgetWindowsPowerShellAfterLaunchFailure } from './powershell-search'
import { buildWindowsPowerShellSpawnAttempts } from './shell-fallback-chain'

// A simulated machine: real installs are never touched.
type SimulatedAppPaths = { machine?: string; user?: string }

const machine = vi.hoisted(() => {
  const appPaths: SimulatedAppPaths = {}
  return {
    files: new Map<string, string>(),
    aliases: new Map<string, string>(),
    // Paths whose stat never settles, like an unreachable network share.
    unresponsive: new Set<string>(),
    appPaths
  }
})

function key(path: string): string {
  return pathWin32.normalize(path).toLowerCase()
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
}

vi.mock('node:fs/promises', () => ({
  stat: async (path: string) => {
    if (machine.unresponsive.has(key(path))) {
      return new Promise(() => {})
    }
    if (!machine.files.has(key(path))) {
      throw enoent(path)
    }
    return { isFile: () => true, size: 4096 }
  },
  readlink: async (path: string) => {
    const target = machine.aliases.get(key(path))
    if (!target) {
      throw enoent(path)
    }
    return target
  },
  readdir: async (dir: string) => {
    const prefix = `${key(dir)}\\`
    const names = new Set<string>()
    for (const original of [...machine.files.values(), ...machine.aliases.keys()]) {
      const normalized = pathWin32.normalize(original)
      if (normalized.toLowerCase().startsWith(prefix)) {
        names.add(normalized.slice(prefix.length).split('\\')[0])
      }
    }
    if (names.size === 0) {
      throw enoent(dir)
    }
    return [...names]
  }
}))

vi.mock('../../../windows/windows-native-registry', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadWindowsNativeRegistry: () => ({
    HK: { CU: 1, LM: 2 },
    getRegistryKey: (root: number) => {
      const value = root === 2 ? machine.appPaths.machine : machine.appPaths.user
      return value === undefined ? null : { '': { name: '', type: 2, value } }
    }
  })
}))

const ENV: NodeJS.ProcessEnv = {
  ProgramW6432: 'C:\\Program Files',
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\dev',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  Path: 'C:\\Windows\\System32'
}
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const CMD = 'C:\\Windows\\System32\\cmd.exe'
const WINDOWS_APPS = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps'
const STORE_EXE =
  'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.3.0_x64__8wekyb3d8bbwe\\pwsh.exe'

function install(...paths: string[]): void {
  for (const path of paths) {
    machine.files.set(key(path), path)
  }
}

function uninstall(path: string): void {
  machine.files.delete(key(path))
}

function alias(path: string, target: string): void {
  machine.aliases.set(key(path), target)
}

let searchId = 0
// Each test gets its own setting so one test's cached search never answers another's.
function freshSetting(): string {
  searchId += 1
  return `pwsh.exe|test-${searchId}`
}

async function findPwsh(
  options: { env?: NodeJS.ProcessEnv; settingKey?: string } = {}
): Promise<string> {
  const chain = await resolveWindowsPowerShellSpawnChain('pwsh.exe', {
    platform: 'win32',
    env: options.env ?? ENV,
    settingKey: options.settingKey ?? freshSetting()
  })
  return chain[0]
}

beforeEach(() => {
  machine.files.clear()
  machine.aliases.clear()
  machine.unresponsive.clear()
  machine.appPaths = {}
  install(WINDOWS_POWERSHELL, CMD)
  // This process's own PATH is the stale one; tests put fresh entries on the terminal env.
  vi.stubEnv('PATH', 'C:\\Windows\\System32')
  vi.stubEnv('Path', 'C:\\Windows\\System32')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('PowerShell 7 discovery sources', () => {
  it('picks the highest Program Files version across 64-bit and 32-bit roots', async () => {
    install(
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Program Files (x86)\\PowerShell\\6\\pwsh.exe',
      'C:\\Program Files (x86)\\PowerShell\\8\\pwsh.exe'
    )
    expect(await findPwsh()).toBe('C:\\Program Files (x86)\\PowerShell\\8\\pwsh.exe')
  })

  it('finds a per-user install', async () => {
    install('C:\\Users\\dev\\AppData\\Local\\Microsoft\\PowerShell\\7\\pwsh.exe')
    expect(await findPwsh()).toBe(
      'C:\\Users\\dev\\AppData\\Local\\Microsoft\\PowerShell\\7\\pwsh.exe'
    )
  })

  it('finds pwsh on the terminal PATH when this process PATH is stale', async () => {
    install('D:\\Tools\\pwsh\\pwsh.exe')
    const env = { ...ENV, Path: 'relative-tools;"D:\\Tools\\pwsh";C:\\Windows\\System32' }
    expect(await findPwsh({ env })).toBe('D:\\Tools\\pwsh\\pwsh.exe')
  })

  it('reads both PATH spellings when a merged env carries PATH and Path', async () => {
    install('D:\\Second\\pwsh.exe')
    const env = { ...ENV, PATH: 'C:\\Windows\\System32', Path: 'D:\\Second' }
    expect(await findPwsh({ env })).toBe('D:\\Second\\pwsh.exe')
  })

  it('stops waiting on an unresponsive PATH entry and uses the install it found', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      install('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
      machine.unresponsive.add(key('\\\\slow-share\\tools\\pwsh.exe'))
      const found = findPwsh({ env: { ...ENV, Path: '\\\\slow-share\\tools' } })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await found).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    } finally {
      vi.useRealTimers()
    }
  })

  it('searches again once a timed-out only install starts responding', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const settingKey = freshSetting()
      const env = { ...ENV, Path: '\\\\slow-share\\tools' }
      install('\\\\slow-share\\tools\\pwsh.exe')
      machine.unresponsive.add(key('\\\\slow-share\\tools\\pwsh.exe'))
      const first = findPwsh({ env, settingKey })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await first).toBe(WINDOWS_POWERSHELL)

      machine.unresponsive.clear()
      expect(await findPwsh({ env, settingKey })).toBe('\\\\slow-share\\tools\\pwsh.exe')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads the App Paths registration, machine before user', async () => {
    install('C:\\Program Files\\Custom PS\\pwsh.exe', 'D:\\User PS\\pwsh.exe')
    machine.appPaths = {
      machine: '"%ProgramFiles%\\Custom PS\\pwsh.exe"',
      user: 'D:\\User PS\\pwsh.exe'
    }
    expect(await findPwsh()).toBe('C:\\Program Files\\Custom PS\\pwsh.exe')
  })

  it('resolves the Store install when WindowsApps is not on PATH', async () => {
    install(STORE_EXE)
    alias(`${WINDOWS_APPS}\\Microsoft.PowerShell_8wekyb3d8bbwe\\pwsh.exe`, STORE_EXE)
    expect(await findPwsh()).toBe(STORE_EXE)
  })

  it.each([
    'C:\\Users\\dev\\.dotnet\\tools\\pwsh.exe',
    'C:\\Users\\dev\\scoop\\apps\\pwsh\\current\\pwsh.exe'
  ])('finds the user tool install %s', async (path) => {
    install(path)
    expect(await findPwsh()).toBe(path)
  })

  it('never launches the zero-byte Store alias itself', async () => {
    install(`${WINDOWS_APPS}\\pwsh.exe`)
    expect(await findPwsh()).toBe(WINDOWS_POWERSHELL)
  })

  it.each(['pwsh.exe', `${WINDOWS_APPS}\\pwsh.exe`, 'C:\\Tools\\powershell.exe'])(
    'rejects unsafe Store alias target %s',
    async (target) => {
      install(target)
      alias(`${WINDOWS_APPS}\\pwsh.exe`, target)
      expect(await findPwsh()).toBe(WINDOWS_POWERSHELL)
    }
  )

  it('uses a preview build only when no stable build exists', async () => {
    const preview = 'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe'
    install(preview)
    expect(await findPwsh()).toBe(preview)

    install('C:\\Users\\dev\\.dotnet\\tools\\pwsh.exe')
    expect(await findPwsh()).toBe('C:\\Users\\dev\\.dotnet\\tools\\pwsh.exe')
  })
})

describe('PowerShell 7 search cache', () => {
  const programFilesPwsh = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  const perUserPwsh = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\PowerShell\\7\\pwsh.exe'

  it('reuses the found path until the shell setting changes', async () => {
    const settingKey = freshSetting()
    install(programFilesPwsh)
    expect(await findPwsh({ settingKey })).toBe(programFilesPwsh)

    uninstall(programFilesPwsh)
    install(perUserPwsh)
    expect(await findPwsh({ settingKey })).toBe(programFilesPwsh)
    expect(await findPwsh({ settingKey: freshSetting() })).toBe(perUserPwsh)
  })

  it('searches again after the cached path fails to launch', async () => {
    const settingKey = freshSetting()
    install(programFilesPwsh)
    expect(await findPwsh({ settingKey })).toBe(programFilesPwsh)

    uninstall(programFilesPwsh)
    install(perUserPwsh)
    forgetWindowsPowerShellAfterLaunchFailure(programFilesPwsh)
    expect(await findPwsh({ settingKey })).toBe(perUserPwsh)
  })

  it('keeps a miss for the same PATH but searches again once the terminal PATH changes', async () => {
    const settingKey = freshSetting()
    expect(await findPwsh({ settingKey })).toBe(WINDOWS_POWERSHELL)

    install('D:\\New\\pwsh.exe')
    expect(await findPwsh({ settingKey })).toBe(WINDOWS_POWERSHELL)
    const env = { ...ENV, Path: `${ENV.Path};D:\\New` }
    expect(await findPwsh({ settingKey, env })).toBe('D:\\New\\pwsh.exe')
  })
})

describe('PowerShell 7 search warm-up', () => {
  it('lets the first terminal find pwsh on its PATH after a warm-up saw a stale PATH', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      vi.resetModules()
      const search = await import('./powershell-search')
      install('D:\\Fresh\\pwsh.exe')
      search.warmWindowsPwshSearch()
      const env = { ...ENV, Path: 'D:\\Fresh;C:\\Windows\\System32' }
      expect(await search.findWindowsPwsh({ env, settingKey: 'powershell.exe|pwsh.exe' })).toBe(
        'D:\\Fresh\\pwsh.exe'
      )
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })
})

describe('PowerShell 7 spawn attempts', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  function attempts(
    requestedShell: string,
    implementation: string,
    pwshNotFoundNotices?: { windowsPowerShell: string; commandPrompt: string }
  ) {
    return buildWindowsPowerShellSpawnAttempts({
      pwshNotFoundNotices,
      shellPath: 'pwsh.exe',
      cwd: 'C:\\repo',
      defaultCwd: 'C:\\repo',
      env: ENV,
      requestedShell,
      powerShellImplementation: implementation
    })
  }

  // The fallback shell prints the notice itself, so it rides ConPTY like any other output.
  function startupScript(attempt: { shellPath: string; shellArgs: string[] }): string {
    return attempt.shellPath === CMD
      ? attempt.shellArgs[1]
      : Buffer.from(attempt.shellArgs[3], 'base64').toString('utf16le')
  }

  it('has each fallback shell announce that PowerShell 7 was not found', async () => {
    const plan = await attempts('powershell.exe', `missing-${freshSetting()}`)
    expect(plan.map((attempt) => attempt.shellPath)).toEqual([WINDOWS_POWERSHELL, CMD])
    expect(startupScript(plan[0])).toMatch(/^Write-Host '\[Orca .*\]' -ForegroundColor Yellow\n/)
    expect(startupScript(plan[1])).toMatch(/ & echo \[Orca .*\]$/)
  })

  it('prints the notice main translated, kept literal in cmd', async () => {
    const plan = await attempts('powershell.exe', `translated-${freshSetting()}`, {
      windowsPowerShell: 'PowerShell 7 fehlt, Windows PowerShell geöffnet.',
      commandPrompt: 'PowerShell 7 fehlt & Eingabeaufforderung (cmd) geöffnet.'
    })
    expect(startupScript(plan[0])).toMatch(
      /^Write-Host '\[PowerShell 7 fehlt, Windows PowerShell geöffnet\.\]' -ForegroundColor Yellow\n/
    )
    expect(startupScript(plan[1])).toMatch(
      / & echo \[PowerShell 7 fehlt \^& Eingabeaufforderung \^\(cmd\^\) geöffnet\.\]$/
    )
  })

  it('opens PowerShell 7 without a notice when it is found', async () => {
    install('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    const plan = await attempts('powershell.exe', `found-${freshSetting()}`)
    expect(plan[0].shellPath).toBe('C:\\Program Files\\PowerShell\\7\\pwsh.exe')
    expect(plan.map(startupScript).join('\n')).not.toContain('[Orca')
  })

  it('prefers a preview build when the shell setting points at one', async () => {
    const preview = 'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe'
    install('C:\\Program Files\\PowerShell\\7\\pwsh.exe', preview)
    const plan = await attempts(preview, `preview-${freshSetting()}`)
    expect(plan[0].shellPath).toBe(preview)
  })
})
