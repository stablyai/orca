import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { once } from 'node:events'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type * as NativeHookExecutableModule from '../agent-hooks/windows-native-hook-executable'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userData' } }))

const { bundledHook } = vi.hoisted(() => {
  const bundledHook: { path: string | null } = { path: null }
  return { bundledHook }
})
vi.mock('../agent-hooks/windows-native-hook-executable', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeHookExecutableModule>()),
  resolveBundledWindowsNativeHookExecutable: () => bundledHook.path
}))

import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import {
  buildWindowsNativeHookExecutable,
  WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS
} from '../agent-hooks/windows-native-hook-exe.test-fixture'
import { openClaudeHookService } from '../openclaude/hook-service'
import { ClaudeHookService } from './hook-service'
import {
  CLAUDE_HOOK_SETTINGS,
  getManagedLifecycleHook,
  getWindowsManagedLifecycleHook
} from './hook-settings'

const CURRENT_CLAUDE = { claudeVersion: '2.1.261 (Claude Code)' }
const EXE = 'orca-agent-hook.exe'
const SCRIPT_PATH = 'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd'
const EXE_PATH = `C:\\Users\\alice\\.orca\\agent-hooks\\${EXE}`

function withWin32<T>(run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return run()
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original)
    }
  }
}

describe('getManagedLifecycleHook native executable gate', () => {
  it('registers the installed exe as a bare path plus the agent', () => {
    const hook = withWin32(() =>
      getManagedLifecycleHook(SCRIPT_PATH, CLAUDE_HOOK_SETTINGS, EXE_PATH)
    )
    expect(hook).toEqual({
      type: 'command',
      command: `C:/Users/alice/.orca/agent-hooks/${EXE} claude`,
      timeout: 10
    })
  })

  it('owns the `<exe> claude` command, and no other agent does', () => {
    const command = `C:/Users/alice/.orca/agent-hooks/${EXE} claude`
    expect(createManagedCommandMatcher('claude-hook.cmd')(command)).toBe(true)
    for (const other of ['openclaude-hook.cmd', 'codebuddy-hook.cmd']) {
      expect(createManagedCommandMatcher(other)(command), other).toBe(false)
    }
    expect(
      createManagedCommandMatcher('claude-hook.cmd')(`${command}x`),
      'a longer agent name'
    ).toBe(false)
  })

  it('falls back to the .cmd form without an installed exe or with a path shells cannot carry', () => {
    for (const exePath of [null, `C:\\Users\\Bob Smith\\.orca\\agent-hooks\\${EXE}`]) {
      const hook = withWin32(() =>
        getManagedLifecycleHook(SCRIPT_PATH, CLAUDE_HOOK_SETTINGS, exePath)
      )
      expect(hook).toEqual(getWindowsManagedLifecycleHook(SCRIPT_PATH))
    }
  })
})

describe.skipIf(process.platform !== 'win32')('ClaudeHookService native hook install', () => {
  let home = ''

  afterEach(() => {
    vi.unstubAllEnvs()
    bundledHook.path = null
    if (home) {
      removeTreeSync(home)
      home = ''
    }
  })

  function useTempHome(): { hooksDir: string; settingsPath: string; bundle: string } {
    home = mkdtempSync(join(tmpdir(), 'orca-claude-native-hook-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    const bundle = join(home, 'bundled-agent-hook.exe')
    writeFileSync(bundle, 'MZ stand-in for the signed bundle')
    return {
      hooksDir: join(home, '.orca', 'agent-hooks'),
      settingsPath: join(home, '.claude', 'settings.json'),
      bundle
    }
  }

  function managedCommands(settingsPath: string, event: string): string[] {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    return settings.hooks[event]
      .flatMap((definition: { hooks: { command: string }[] }) => definition.hooks)
      .map((hook: { command: string }) => hook.command)
      .filter(createManagedCommandMatcher('claude-hook.cmd'))
  }

  const exeCommand = (hooksDir: string): string =>
    `${join(hooksDir, EXE).replaceAll('\\', '/')} claude`

  // Holding stdin open keeps the hook image mapped to exercise locked-executable replacement.
  function startHeldHook(program: string): PipedChildProcess {
    return spawnProcess({
      program,
      args: ['claude'],
      env: {
        SystemRoot: process.env.SystemRoot,
        ORCA_AGENT_HOOK_PORT: '1',
        ORCA_AGENT_HOOK_TOKEN: 'token',
        ORCA_PANE_KEY: 'tab:leaf'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
  }

  it('copies the bundled exe and registers it, keeping the .cmd pair as the fallback', () => {
    const { hooksDir, settingsPath, bundle } = useTempHome()
    bundledHook.path = bundle

    expect(new ClaudeHookService().install(CURRENT_CLAUDE).state).toBe('installed')
    expect(readFileSync(join(hooksDir, EXE), 'utf8')).toBe('MZ stand-in for the signed bundle')
    expect(existsSync(join(hooksDir, 'claude-hook.cmd'))).toBe(true)
    expect(existsSync(join(hooksDir, 'claude-hook-impl.cmd'))).toBe(true)
    expect(managedCommands(settingsPath, 'PreToolUse')).toEqual([exeCommand(hooksDir)])
  })

  it('leaves unchanged bytes unwritten', () => {
    const { hooksDir, bundle } = useTempHome()
    bundledHook.path = bundle
    const service = new ClaudeHookService()
    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
    const before = statSync(join(hooksDir, EXE), { bigint: true })

    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
    const after = statSync(join(hooksDir, EXE), { bigint: true })
    expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs])
  })

  it('registers the .cmd hook when no signed exe ships, and status accepts either form', () => {
    const { hooksDir, settingsPath, bundle } = useTempHome()
    const service = new ClaudeHookService()

    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
    const cmdCommand = join(hooksDir, 'claude-hook.cmd').replaceAll('\\', '/')
    expect(managedCommands(settingsPath, 'Stop')).toEqual([cmdCommand])

    bundledHook.path = bundle
    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
    expect(managedCommands(settingsPath, 'Stop')).toEqual([exeCommand(hooksDir)])

    bundledHook.path = join(home, 'missing.exe')
    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
    expect(managedCommands(settingsPath, 'Stop')).toEqual([exeCommand(hooksDir)])

    rmSync(join(hooksDir, EXE))
    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
    expect(managedCommands(settingsPath, 'Stop')).toEqual([cmdCommand])
  })

  it('reports a registered exe that has gone missing as partial', () => {
    const { hooksDir, bundle } = useTempHome()
    bundledHook.path = bundle
    const service = new ClaudeHookService()
    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')

    rmSync(join(hooksDir, EXE))
    expect(service.getStatus(CURRENT_CLAUDE).state).toBe('partial')
  })

  it('refreshes a surviving exe to this build, and never creates one', async () => {
    const { hooksDir, bundle } = useTempHome()
    const service = new ClaudeHookService()
    bundledHook.path = bundle
    await service.refreshManagedScripts()
    expect(existsSync(join(hooksDir, EXE))).toBe(false)

    expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
    writeFileSync(bundle, 'MZ next build')
    await service.refreshManagedScripts()
    expect(readFileSync(join(hooksDir, EXE), 'utf8')).toBe('MZ next build')
  })

  it('leaves every other Claude-compatible agent on its .cmd form', () => {
    const { hooksDir, bundle } = useTempHome()
    bundledHook.path = bundle

    expect(openClaudeHookService.install().state).toBe('installed')
    expect(readdirSync(hooksDir).filter((name) => name.endsWith('.exe'))).toEqual([])
  })

  it(
    'replaces a copy whose hook is still running by moving it aside, in install and refresh',
    { timeout: WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS },
    async () => {
      const { hooksDir, settingsPath } = useTempHome()
      bundledHook.path = buildWindowsNativeHookExecutable()
      const service = new ClaudeHookService()
      expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
      const installed = join(hooksDir, EXE)
      const built = readFileSync(installed)
      const nextBuild = (tag: string): Buffer => {
        const path = join(home, `${tag}.exe`)
        writeFileSync(path, Buffer.concat([built, Buffer.from(tag)]))
        bundledHook.path = path
        return readFileSync(path)
      }

      const held = startHeldHook(installed)
      try {
        await once(held.stdout, 'data')
        const next = nextBuild('next')
        expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
        expect(managedCommands(settingsPath, 'Stop')).toEqual([exeCommand(hooksDir)])
        expect(readFileSync(installed).equals(next)).toBe(true)
        expect(readFileSync(`${installed}.old`).equals(built)).toBe(true)
      } finally {
        held.stdin.end()
        await once(held, 'close')
      }

      const refreshing = startHeldHook(installed)
      try {
        await once(refreshing.stdout, 'data')
        const later = nextBuild('later')
        await service.refreshManagedScripts()
        expect(readFileSync(installed).equals(later)).toBe(true)
      } finally {
        refreshing.stdin.end()
        await once(refreshing, 'close')
      }

      expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
      expect(existsSync(`${installed}.old`)).toBe(false)
    }
  )
})
