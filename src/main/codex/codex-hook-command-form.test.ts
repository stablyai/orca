import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  buildWindowsHookPowerShellCommand,
  createManagedCommandMatcher,
  wrapWindowsHookCommand,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  buildCodexHookCommand,
  CODEX_HOOK_COMMAND_FORM,
  readCodexHookCommandForm
} from './codex-hook-command-form'
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { planRealHomeCodexHookEntries } from './codex-real-home-hook-entry-plan'

// Why goldens: these bytes are shared by every Orca on a HOME. Changing them
// without a form bump makes builds rewrite each other's entry again.
const POSIX_GOLDEN =
  ': orca-agent-hook-form=1; if [ -n "${ORCA_PANE_KEY-}" ] && [ -n "${ORCA_AGENT_HOOK_ROOT-}" ] && [ -f "${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" ]; then /bin/sh "${ORCA_AGENT_HOOK_ROOT-}/agent-hooks/codex-hook.sh" || :; elif [ -z "${ORCA_AGENT_HOOK_ROOT-}" ] && [ -n "${ORCA_PANE_KEY-}" ] && [ -n "${ORCA_AGENT_HOOK_PORT-}" ] && [ -f "${HOME-}/.orca/agent-hooks/codex-hook.sh" ]; then /bin/sh "${HOME-}/.orca/agent-hooks/codex-hook.sh" || :; else { command -p cat 2>/dev/null || cat; } >/dev/null 2>&1 || :; fi'
const WINDOWS_BARE_GOLDEN = 'C:/Users/alice/.orca/agent-hooks/codex-hook.cmd'
const WINDOWS_CMD_GOLDEN =
  'C:\\Windows\\System32\\cmd.exe --% /d /v:off /c @"C:/Users/First Last/.orca/agent-hooks/codex-hook.cmd"'
// Why kept: local builds before the absolute cmd.exe wrote it; the managed installer and the app-start reconcile convert it.
const WINDOWS_BARE_CMD_SPELLING =
  'cmd --% /d /c @"C:/Users/First Last/.orca/agent-hooks/codex-hook.cmd"'
const WINDOWS_ENV = { SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }
// Why kept: dev builds of this form wrote it for a spaced profile path; app start converts it.
const WINDOWS_POWERSHELL_TEXT =
  "<# orca-agent-hook-form=1 #> if ($env:ORCA_PANE_KEY -and $env:ORCA_AGENT_HOOK_ROOT -and (Test-Path -LiteralPath (Join-Path $env:ORCA_AGENT_HOOK_ROOT 'agent-hooks\\codex-hook.cmd') -PathType Leaf)) { & (Join-Path $env:ORCA_AGENT_HOOK_ROOT 'agent-hooks\\codex-hook.cmd') } elseif (-not $env:ORCA_AGENT_HOOK_ROOT -and $env:ORCA_PANE_KEY -and $env:ORCA_AGENT_HOOK_PORT -and (Test-Path -LiteralPath 'C:/Users/First Last/.orca/agent-hooks/codex-hook.cmd' -PathType Leaf)) { & 'C:/Users/First Last/.orca/agent-hooks/codex-hook.cmd' } else { if (-not $env:ORCA_AGENT_HOOK_PORT -or -not $env:ORCA_AGENT_HOOK_TOKEN -or -not $env:ORCA_PANE_KEY) { exit 0 }; [Console]::In.ReadToEnd() | Out-Null }; exit 0"

function windowsCommandFor(
  profileDirName: string,
  env: Record<string, string | undefined> = WINDOWS_ENV
): string {
  return buildCodexHookCommand(
    `C:\\Users\\${profileDirName}\\.orca\\agent-hooks\\codex-hook.cmd`,
    'win32',
    env
  )
}

describe('frozen Codex hook command', () => {
  it('matches the form 1 goldens', () => {
    expect(CODEX_HOOK_COMMAND_FORM).toBe(1)
    expect(buildCodexHookCommand('/home/a/.orca/agent-hooks/codex-hook.sh', 'linux')).toBe(
      POSIX_GOLDEN
    )
    expect(windowsCommandFor('alice')).toBe(WINDOWS_BARE_GOLDEN)
    expect(windowsCommandFor('First Last')).toBe(WINDOWS_CMD_GOLDEN)
  })

  it.each([' ', '&', '^', '$', '`', "'", '!', '(', ')', 'é', '测'])(
    'takes the cmd spelling for a profile path holding %j',
    (character) => {
      const name = `a${character}b`
      expect(windowsCommandFor(name)).toBe(
        `C:\\Windows\\System32\\cmd.exe --% /d /v:off /c @"C:/Users/${name}/.orca/agent-hooks/codex-hook.cmd"`
      )
    }
  )

  it.each(['alice', 'Alice.Smith-2', 'a_b', 'ALICE~1'])(
    'keeps the bare path for the safe profile path %s',
    (name) => {
      expect(windowsCommandFor(name)).toBe(`C:/Users/${name}/.orca/agent-hooks/codex-hook.cmd`)
    }
  )

  it('writes the same Windows bytes for a path in either slash direction', () => {
    for (const name of ['alice', 'First Last']) {
      const backslashed = `C:\\Users\\${name}\\.orca\\agent-hooks\\codex-hook.cmd`
      expect(buildCodexHookCommand(backslashed, 'win32', WINDOWS_ENV)).toBe(
        buildCodexHookCommand(backslashed.replaceAll('\\', '/'), 'win32', WINDOWS_ENV)
      )
    }
  })

  it('names the system cmd.exe from %SystemRoot%, on any drive, with backslashes', () => {
    expect(windowsCommandFor('First Last', { SystemRoot: 'D:\\Windows' })).toBe(
      'D:\\Windows\\System32\\cmd.exe --% /d /v:off /c @"C:/Users/First Last/.orca/agent-hooks/codex-hook.cmd"'
    )
    expect(windowsCommandFor('First Last', { SystemRoot: 'C:\\WINDOWS\\' })).toBe(
      WINDOWS_CMD_GOLDEN.replace('C:\\Windows\\', 'C:\\WINDOWS\\')
    )
    // Why: a safe profile path never names cmd.exe, whatever the Windows directory.
    expect(windowsCommandFor('alice', { SystemRoot: 'D:\\Windows' })).toBe(WINDOWS_BARE_GOLDEN)
  })

  it('falls back to the Windows directory holding %ComSpec% when %SystemRoot% is unset', () => {
    expect(windowsCommandFor('First Last', { ComSpec: 'E:\\WinNT\\system32\\cmd.exe' })).toBe(
      'E:\\WinNT\\System32\\cmd.exe --% /d /v:off /c @"C:/Users/First Last/.orca/agent-hooks/codex-hook.cmd"'
    )
    // Why: both sources name the same directory on a machine, so a process missing one writes the same bytes.
    expect(windowsCommandFor('First Last', { ComSpec: 'C:\\Windows\\system32\\cmd.exe' })).toBe(
      WINDOWS_CMD_GOLDEN
    )
  })

  it.each([
    ['unset', {}],
    ['relative', { SystemRoot: 'Windows' }],
    ['spaced', { SystemRoot: 'C:\\My Windows' }],
    ['holding &', { SystemRoot: 'C:\\Win&dows' }],
    ['a UNC share', { SystemRoot: '\\\\server\\Windows' }],
    ['another shell in %ComSpec%', { ComSpec: 'C:\\Tools\\tcc.exe' }],
    ['a spaced %ComSpec%', { ComSpec: 'C:\\My Windows\\System32\\cmd.exe' }]
  ])(
    'names C:\\Windows\\System32\\cmd.exe, never a bare or quoted cmd, when the Windows directory is %s',
    (_case, env) => {
      expect(windowsCommandFor('First Last', env)).toBe(WINDOWS_CMD_GOLDEN)
    }
  )

  it('writes identical bytes for the same profile path and Windows directory', () => {
    const first = windowsCommandFor('First Last', { SystemRoot: 'D:\\Windows' })
    expect(windowsCommandFor('First Last', { SystemRoot: 'D:\\Windows' })).toBe(first)
    expect(windowsCommandFor('First Last', { SystemRoot: 'D:/Windows/' })).toBe(first)
  })

  it('writes identical POSIX bytes whatever the home or build', () => {
    expect(buildCodexHookCommand('/Users/a/.orca/agent-hooks/codex-hook.sh', 'darwin')).toBe(
      buildCodexHookCommand('/home/b/.orca/agent-hooks/codex-hook.sh', 'linux')
    )
  })

  it.each([POSIX_GOLDEN, WINDOWS_BARE_GOLDEN, WINDOWS_CMD_GOLDEN])(
    'keeps the script name in plain text so every older build still recognizes it',
    (command) => {
      const isOrca = createManagedCommandMatcher(
        command === POSIX_GOLDEN ? 'codex-hook.sh' : 'codex-hook.cmd'
      )
      expect(isOrca(command)).toBe(true)
    }
  )

  it('reads the form: current, higher, and unmarked older forms', () => {
    expect(readCodexHookCommandForm(POSIX_GOLDEN, POSIX_GOLDEN)).toBe(1)
    expect(readCodexHookCommandForm(WINDOWS_BARE_GOLDEN, WINDOWS_BARE_GOLDEN)).toBe(1)
    expect(readCodexHookCommandForm(POSIX_GOLDEN.replace('form=1', 'form=2'), POSIX_GOLDEN)).toBe(2)
    expect(
      readCodexHookCommandForm(
        "if [ -f '/h/.orca/agent-hooks/codex-hook.sh' ]; then /bin/sh '/h/.orca/agent-hooks/codex-hook.sh'; fi",
        POSIX_GOLDEN
      )
    ).toBe(0)
    expect(
      readCodexHookCommandForm(
        'C:\\Users\\alice\\.orca\\agent-hooks\\codex-hook.cmd',
        WINDOWS_BARE_GOLDEN
      )
    ).toBe(0)
  })
})

describe('the Windows spelling change', () => {
  const hooksWith = (command: string): Record<string, HookDefinition[]> => ({
    Stop: [
      { hooks: [{ type: 'command', command, timeout: 10 }] },
      { hooks: [{ type: 'command', command: 'user-hook.cmd' }] }
    ]
  })
  const plan = (command: string, convertOlderForms: boolean) =>
    planRealHomeCodexHookEntries({
      hooks: hooksWith(command),
      sourcePath: 'C:/Users/First Last/.codex/hooks.json',
      material: {
        ...getCodexManagedHookInstallMaterial(),
        events: ['Stop'],
        command: WINDOWS_CMD_GOLDEN
      },
      isOrcaCommand: createManagedCommandMatcher('codex-hook.cmd'),
      convertOlderForms
    })

  it.each([
    ['the PowerShell-text form', WINDOWS_POWERSHELL_TEXT],
    ['the bare-cmd spelling', WINDOWS_BARE_CMD_SPELLING],
    [
      "main's PowerShell text",
      buildWindowsHookPowerShellCommand('C:\\Users\\First Last\\.orca\\agent-hooks\\codex-hook.cmd')
    ],
    [
      'the encoded launcher',
      wrapWindowsHookCommand('C:\\Users\\First Last\\.orca\\agent-hooks\\codex-hook.cmd')
    ]
  ])('converts %s to the cmd.exe spelling once, in its slot, at app start', (_case, older) => {
    const converted = plan(older, true)
    expect(converted).toMatchObject({ kind: 'settle', changedLabels: new Set(['stop']) })
    expect(converted.hooks.Stop).toEqual([
      { hooks: [{ type: 'command', command: WINDOWS_CMD_GOLDEN, timeout: 10 }] },
      { hooks: [{ type: 'command', command: 'user-hook.cmd' }] }
    ])
    expect(plan(WINDOWS_CMD_GOLDEN, true)).toMatchObject({ changedLabels: new Set() })
  })

  it.each([WINDOWS_POWERSHELL_TEXT, WINDOWS_BARE_CMD_SPELLING])(
    'leaves the older Windows form %# alone on a pane launch',
    (older) => {
      expect(plan(older, false)).toMatchObject({ changedLabels: new Set() })
    }
  )
})

describe.skipIf(process.platform === 'win32')('frozen Codex hook command under /bin/sh', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function makeScripts(): { home: string; root: string; marker: string } {
    const dir = mkdtempSync(join(tmpdir(), 'orca-codex-hook-form-'))
    roots.push(dir)
    const home = join(dir, 'home')
    const root = join(dir, 'root')
    const marker = join(dir, 'ran')
    for (const [base, label] of [
      [join(home, '.orca'), 'shared'],
      [root, 'root']
    ]) {
      mkdirSync(join(base, 'agent-hooks'), { recursive: true })
      writeFileSync(
        join(base, 'agent-hooks', 'codex-hook.sh'),
        `cat >/dev/null; printf ${label} >> '${marker}'; exit 2\n`
      )
    }
    return { home, root, marker }
  }

  async function run(env: Record<string, string>): Promise<{ code: number | null; ran: string }> {
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', POSIX_GOLDEN],
      input: '{"hook_event_name":"Stop"}',
      env: { PATH: process.env.PATH ?? '', ...env },
      timeoutMs: 10_000
    })
    const ran = existsSync(env.MARKER) ? readFileSync(env.MARKER, 'utf-8') : ''
    return { code: result.code, ran }
  }

  it.each([
    ['outside Orca', {}, ''],
    ['a pane with hooks off', { ORCA_PANE_KEY: 'tab:leaf' }, ''],
    ['a pane with hooks on', { ORCA_PANE_KEY: 'tab:leaf', ORCA_AGENT_HOOK_PORT: '1' }, 'shared'],
    [
      'a structured child with a root',
      { ORCA_AGENT_HOOK_PORT: '1', ORCA_AGENT_HOOK_ROOT: 'R' },
      ''
    ],
    [
      'a pane with a hook root',
      { ORCA_PANE_KEY: 'tab:leaf', ORCA_AGENT_HOOK_PORT: '1', ORCA_AGENT_HOOK_ROOT: 'R' },
      'root'
    ]
  ])('runs the right script for %s and always exits 0', async (_case, env, expected) => {
    const scripts = makeScripts()
    const resolved: Record<string, string> = Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, value === 'R' ? scripts.root : value])
    )
    expect(await run({ ...resolved, HOME: scripts.home, MARKER: scripts.marker })).toEqual({
      code: 0,
      ran: expected
    })
  })
})
