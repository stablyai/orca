import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import type * as NativeHookExecutableModule from '../agent-hooks/installation/commands/windows-native-hook-executable'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userData' } }))

const { bundledHook } = vi.hoisted(() => {
  const bundledHook: { path: string | null } = { path: null }
  return { bundledHook }
})
vi.mock(
  '../agent-hooks/installation/commands/windows-native-hook-executable',
  async (importOriginal) => ({
    ...(await importOriginal<typeof NativeHookExecutableModule>()),
    resolveBundledWindowsNativeHookExecutable: () => bundledHook.path
  })
)

import {
  createManagedCommandMatcher,
  removeManagedCommands
} from '../agent-hooks/installation/commands/managed-hook-command-matching'
import type {
  HookCommandConfig,
  HookDefinition
} from '../agent-hooks/installation/configuration/hook-config-schema'
import {
  buildWindowsNativeHookExecutable,
  WINDOWS_NATIVE_HOOK_BUILD_TIMEOUT_MS
} from '../agent-hooks/installation/commands/testing/windows-native-hook-exe.test-fixture'
import { ClaudeHookService } from './hook-service'

const CURRENT_CLAUDE = { claudeVersion: '2.1.261 (Claude Code)' }
const EXE = 'orca-agent-hook.exe'

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

  function useTempHome(prefix = 'orca-claude-native-hook-'): {
    hooksDir: string
    settingsPath: string
    bundle: string
  } {
    home = mkdtempSync(join(tmpdir(), prefix))
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

  function managedHooks(settingsPath: string, event: string): HookCommandConfig[] {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    const definitions: HookDefinition[] = settings.hooks[event]
    const isManaged = createManagedCommandMatcher('claude-hook.cmd')
    return definitions
      .flatMap((definition) => definition.hooks ?? [])
      .filter((hook) => removeManagedCommands([{ hooks: [hook] }], isManaged).length === 0)
  }

  function managedCommands(settingsPath: string, event: string): string[] {
    return managedHooks(settingsPath, event).map((hook) => hook.command)
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
