import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { removeTreeSync } from '../../../../shared/windows-transient-lock-removal'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type * as osModule from 'node:os'

const { homedirMock } = vi.hoisted(() => ({ homedirMock: vi.fn<() => string>() }))

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof osModule>()
  return {
    ...actual,
    homedir: homedirMock.mockImplementation(actual.homedir)
  }
})
import { CopilotHookService } from '../../../copilot/hook-service'
import {
  WINDOWS_POWERSHELL_WARM_UP_TIMEOUT_MS,
  warmWindowsEncodedPowerShell
} from './testing/windows-powershell-warm-up.test-fixture'
// Multiple chunks and non-ASCII expose pipe truncation and code-page conversion.
const PAYLOAD = JSON.stringify({
  session_id: 'a3f9c1e0-payload-delivery',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'echo "café 日本語 😀" & echo %PATH% | more' },
  transcript: 'y'.repeat(4096)
})

type Runner = {
  name: string
  program: () => string
  args: (command: string) => string[]
  verbatim?: boolean
}

const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
const CMD = join(SYSTEM32, 'cmd.exe')
const POWERSHELL = join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
function findPwsh(): string | undefined {
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'pwsh.exe')
  ]
  // lstat: the Store install is an app-execution alias that existsSync cannot follow.
  return candidates.find((candidate) => lstatSync(candidate, { throwIfNoEntry: false }))
}
// Copilot's `<pwsh|powershell> -nop -nol -c <command>`; pwsh only where it is installed.
const COPILOT_RUNNERS: Runner[] = [POWERSHELL, findPwsh()].flatMap((program) =>
  program
    ? [
        {
          name: `${basename(program)} (Copilot)`,
          program: () => program,
          args: (c: string) => ['-nop', '-nol', '-c', c]
        }
      ]
    : []
)

type Entry = { command?: string; powershell?: string; hooks?: { command?: string }[] }
const commandsOf = (entries: Entry[] | undefined): (string | undefined)[] =>
  (entries ?? []).flatMap((entry) =>
    entry.hooks ? entry.hooks.map((h) => h.command) : (entry.command ?? entry.powershell)
  )

function readEvent(path: string, event: string): (string | undefined)[] {
  return commandsOf(JSON.parse(readFileSync(path, 'utf8')).hooks?.[event])
}

// Inherited Orca endpoints must not redirect test payloads away from this listener.
function hookEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ORCA_'))
  )
  return { ...base, ORCA_BACKGROUND_LAUNCH: '1', ...extra }
}

describe.skipIf(process.platform !== 'win32')('Windows managed hook payload delivery', () => {
  let root = ''

  beforeAll(
    () => warmWindowsEncodedPowerShell(hookEnvironment({})),
    WINDOWS_POWERSHELL_WARM_UP_TIMEOUT_MS
  )

  afterEach(() => {
    vi.unstubAllEnvs()
    homedirMock.mockImplementation(() => process.env.HOME ?? tmpdir())
    if (root) {
      removeTreeSync(root)
      root = ''
    }
  })

  // The control verifies profile-based AutoRun ran; printing it must not corrupt Copilot gate JSON.
  it('Copilot answers exactly {} when the cmd AutoRun prints', async () => {
    root = mkdtempSync(join(tmpdir(), 'orca-hook-autorun-'))
    const home = join(root, 'user')
    mkdirSync(home)
    homedirMock.mockReturnValue(home)
    for (const name of ['USERPROFILE', 'HOME']) {
      vi.stubEnv(name, home)
    }
    vi.stubEnv('COPILOT_HOME', undefined)
    writeFileSync(join(home, '.cmd_aliases.cmd'), '@echo autorun-noise\r\n', 'utf8')
    expect(new CopilotHookService().install().state).toBe('installed')
    const [command] = readEvent(join(home, '.copilot', 'hooks', 'orca.json'), 'PreToolUse')
    if (!command) {
      throw new Error('Missing managed Copilot PreToolUse command')
    }
    const env = hookEnvironment({ USERPROFILE: home, HOME: home })

    const autoRun = await runProcess({ program: CMD, args: ['/c', 'rem'], env, timeoutMs: 15_000 })
    for (const runner of COPILOT_RUNNERS) {
      const result = await runProcess({
        program: runner.program(),
        args: runner.args(command),
        env,
        input: PAYLOAD,
        timeoutMs: 15_000
      })
      expect(result.code, `${runner.name} exit code`).toBe(0)
      expect(result.stdout, `${runner.name} stdout`).toBe('{}\r\n')
    }
    if (autoRun.stdout.includes('autorun-noise')) {
      const bare = command.replace(/^\S+\/cmd\.exe \/d \/c /, '')
      const control = await runProcess({
        program: POWERSHELL,
        args: ['-nop', '-nol', '-c', bare],
        env,
        input: PAYLOAD,
        timeoutMs: 15_000
      })
      expect(control.stdout, 'without /d the AutoRun prints first').toContain('autorun-noise')
    }
  }, 60_000)
})
