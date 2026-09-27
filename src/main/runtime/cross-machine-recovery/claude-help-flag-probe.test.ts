import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStartupSettings } from '../../../shared/agent-startup-plan-inputs'
import { runProcess, type ProcessSpec } from '../../../shared/child-process/run-process'
import { buildAgentResumeStartupPlan } from '../../../shared/tui-agent-resume-startup'
import { createClaudeHelpFlagProbe, type ClaudeHelpFlagProbeHost } from './claude-help-flag-probe'

const FLAG = '--append-system-prompt'
const ADVERTISED = '  --append-system-prompt <prompt>  Append a system prompt'
const UNADVERTISED = '  --system-prompt <prompt>  Replace the system prompt'
const ZSH = '/bin/zsh'
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe'

function fakeRun(stdoutByCommand: Record<string, string> = {}, code = 0) {
  return vi.fn(async (spec: ProcessSpec) => ({
    code,
    signal: null,
    stdout: stdoutByCommand[spec.args?.at(-1) ?? ''] ?? ADVERTISED,
    stderr: '',
    timedOut: false
  }))
}

function host(
  run: ClaudeHelpFlagProbeHost['run'],
  platform: NodeJS.Platform = 'darwin',
  profileShell: string | null = ZSH
): ClaudeHelpFlagProbeHost {
  return { run, platform, profileShell: () => profileShell }
}

describe('createClaudeHelpFlagProbe', () => {
  it.each([
    [ADVERTISED, true],
    [UNADVERTISED, false]
  ])('probes one invocation once: %s', async (stdout, advertised) => {
    const run = fakeRun({ "claude '--help'": stdout })
    const probe = createClaudeHelpFlagProbe(FLAG, () => ({}), host(run))
    expect(await probe()).toBe(advertised)
    expect(await probe()).toBe(advertised)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it.each<[string, AgentStartupSettings, string]>([
    ['PATH claude without an override', {}, "claude '--help'"],
    [
      'PATH claude when only another agent is overridden',
      { agentCmdOverrides: { codex: '/opt/codex' } },
      "claude '--help'"
    ],
    [
      'a tilde path with its fixed args',
      { agentCmdOverrides: { claude: '~/bin/claude --profile work' } },
      "~/bin/claude --profile work '--help'"
    ],
    [
      'an environment-variable path',
      { agentCmdOverrides: { claude: '$HOME/.local/bin/claude' } },
      "$HOME/.local/bin/claude '--help'"
    ],
    [
      'a quoted path behind an env prefix',
      { agentCmdOverrides: { claude: "CLAUDE_CONFIG_DIR=/tmp/cfg '/opt/my claude/claude'" } },
      "CLAUDE_CONFIG_DIR=/tmp/cfg '/opt/my claude/claude' '--help'"
    ],
    [
      'an override without the stale selector resume strips',
      { agentCmdOverrides: { claude: 'claude --resume stale-id' } },
      "claude '--help'"
    ]
  ])('types %s into the POSIX profile shell', async (_name, settings, command) => {
    const run = fakeRun()
    await createClaudeHelpFlagProbe(FLAG, () => settings, host(run))()
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ program: ZSH, args: ['-ilc', command] })
    )
  })

  it.each<[string, AgentStartupSettings, string, Partial<ProcessSpec>]>([
    [
      'a PowerShell call-operator override',
      {
        agentCmdOverrides: { claude: "& 'C:\\Program Files\\Claude\\claude.exe'" },
        terminalWindowsShell: 'powershell.exe'
      },
      PWSH,
      {
        program: PWSH,
        args: ['-NoLogo', '-Command', "& 'C:\\Program Files\\Claude\\claude.exe' '--help'"]
      }
    ],
    [
      'PowerShell as the default Windows shell',
      { agentCmdOverrides: { claude: '$env:LOCALAPPDATA\\Claude\\claude.exe' } },
      PWSH,
      {
        program: PWSH,
        args: ['-NoLogo', '-Command', "$env:LOCALAPPDATA\\Claude\\claude.exe '--help'"]
      }
    ],
    [
      'a cmd override',
      {
        agentCmdOverrides: { claude: '"%LOCALAPPDATA%\\Claude\\claude.exe"' },
        terminalWindowsShell: 'cmd.exe'
      },
      PWSH,
      {
        program: expect.stringMatching(/cmd\.exe$/i),
        args: ['/s', '/c', '""%LOCALAPPDATA%\\Claude\\claude.exe" "--help""'],
        windowsVerbatimArguments: true
      }
    ],
    [
      'a Git Bash override',
      { agentCmdOverrides: { claude: '~/bin/claude' }, terminalWindowsShell: 'git-bash' },
      GIT_BASH,
      { program: GIT_BASH, args: ['-ilc', "~/bin/claude '--help'"] }
    ]
  ])('types %s into the configured Windows shell', async (_name, settings, shell, spec) => {
    const run = fakeRun()
    await createClaudeHelpFlagProbe(FLAG, () => settings, host(run, 'win32', shell))()
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(spec))
  })

  it('reads a shell it cannot run headless as unadvertised without running it', async () => {
    const run = fakeRun()
    const probe = createClaudeHelpFlagProbe(
      FLAG,
      () => ({ terminalWindowsShell: 'wsl.exe' }),
      host(run, 'win32', null)
    )
    expect(await probe()).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('hands the shell the agent launch env resume sets', async () => {
    const run = fakeRun()
    await createClaudeHelpFlagProbe(
      FLAG,
      () => ({
        agentCmdOverrides: { claude: '$CLAUDE_BIN/claude' },
        agentDefaultEnv: { claude: { CLAUDE_BIN: '/opt/claude/bin' } }
      }),
      host(run)
    )()
    expect(run).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        args: ['-ilc', "$CLAUDE_BIN/claude '--help'"],
        env: expect.objectContaining({ CLAUDE_BIN: '/opt/claude/bin' })
      })
    )
  })

  it('re-probes when the override, env, or shell changes and keeps each verdict', async () => {
    const run = fakeRun({ "/opt/new/claude '--help'": UNADVERTISED })
    let settings: AgentStartupSettings = { agentCmdOverrides: { claude: '/opt/old/claude' } }
    const probe = createClaudeHelpFlagProbe(FLAG, () => settings, host(run))
    expect(await probe()).toBe(true)
    settings = { agentCmdOverrides: { claude: '/opt/new/claude' } }
    expect(await probe()).toBe(false)
    expect(await probe()).toBe(false)
    settings = { ...settings, agentDefaultEnv: { claude: { CLAUDE_BIN: '/opt' } } }
    expect(await probe()).toBe(false)
    settings = {}
    expect(await probe()).toBe(true)
    expect(run.mock.calls.map(([spec]) => [spec.args?.at(-1), spec.env?.CLAUDE_BIN])).toEqual([
      ["/opt/old/claude '--help'", undefined],
      ["/opt/new/claude '--help'", undefined],
      ["/opt/new/claude '--help'", '/opt'],
      ["claude '--help'", undefined]
    ])
  })

  it('reads a shell that cannot start as unadvertised', async () => {
    const run = vi.fn(async () => {
      throw new Error('spawn /bin/zsh ENOENT')
    })
    expect(await createClaudeHelpFlagProbe(FLAG, () => ({}), host(run))()).toBe(false)
  })

  it('reads a failed help as unadvertised even when it names the flag', async () => {
    const run = fakeRun({}, 127)
    expect(await createClaudeHelpFlagProbe(FLAG, () => ({}), host(run))()).toBe(false)
  })
})

function executable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return null
}

const LIVE_SHELLS = [
  ['bash', executable(['/bin/bash', '/usr/bin/bash'])],
  ['zsh', executable(['/bin/zsh', '/usr/bin/zsh'])],
  ['fish', executable(['/opt/homebrew/bin/fish', '/usr/local/bin/fish', '/usr/bin/fish'])]
] as const

describe.skipIf(process.platform === 'win32')('createClaudeHelpFlagProbe in a real shell', () => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) {
      rmSync(home, { recursive: true, force: true })
    }
  })

  for (const [name, shell] of LIVE_SHELLS) {
    it
      .skipIf(shell === null)
      .each(['~/bin/claude', '$CLAUDE_BIN/claude', 'CLAUDE_PROBE_TAG=1 ~/bin/claude'])(
      `runs the binary resume launches for %s under ${name}`,
      async (override) => {
        const home = mkdtempSync(join(tmpdir(), 'claude-help-probe-'))
        homes.push(home)
        const ledger = join(home, 'argv.log')
        mkdirSync(join(home, 'bin'))
        writeFileSync(
          join(home, 'bin', 'claude'),
          `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ledger}'\nprintf '%s\\n' '${ADVERTISED}'\n`
        )
        chmodSync(join(home, 'bin', 'claude'), 0o755)
        const settings: AgentStartupSettings = {
          agentCmdOverrides: { claude: override },
          agentDefaultEnv: { claude: { HOME: home, CLAUDE_BIN: join(home, 'bin') } }
        }
        const probe = createClaudeHelpFlagProbe(FLAG, () => settings, {
          run: runProcess,
          platform: process.platform,
          profileShell: () => shell
        })
        expect(await probe()).toBe(true)

        const resume = buildAgentResumeStartupPlan({
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'session-1' },
          cmdOverrides: settings.agentCmdOverrides ?? {},
          agentEnv: settings.agentDefaultEnv?.claude,
          platform: process.platform
        })
        await runProcess({
          program: shell!,
          args: ['-ilc', resume!.launchCommand],
          env: { ...process.env, ...resume!.env },
          timeoutMs: 10_000
        })
        expect(readFileSync(ledger, 'utf8').trim().split('\n')).toEqual([
          '--help',
          '--resume session-1'
        ])
      }
    )
  }
})
