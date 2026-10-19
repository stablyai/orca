import { runProcess } from '@orca/process-host'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentHookMemorySftp } from '../agent-hooks/agent-hook-memory-sftp.test-fixture'
import { wrapRuntimeHomePosixHookCommand } from '../agent-hooks/runtime-home-hook-command'
import { ClaudeHookService } from './hook-service'
import {
  CLAUDE_HOOK_SETTINGS,
  getManagedEventHook,
  getManagedLifecycleHook,
  getRemoteManagedCommand,
  getRemoteManagedEventCommand
} from './hook-settings'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userData' } }))

const SCRIPT_PATH = '/home/test/.orca/agent-hooks/claude-hook.sh'
const CURRENT_CLAUDE = { claudeVersion: '2.1.261 (Claude Code)' }
// Why: Claude prints the command verbatim after every /compact; the full wrapper is ~3KB.
const MAX_ECHOED_COMMAND_LENGTH = 400

afterEach(() => vi.restoreAllMocks())

describe('PostCompact managed hook command', () => {
  it.each(['darwin', 'linux'] as const)('is the short POSIX form on %s', (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    const { command } = getManagedEventHook('PostCompact', SCRIPT_PATH)

    expect(command.length).toBeLessThan(MAX_ECHOED_COMMAND_LENGTH)
    expect(command).toContain('if [ -n "${HOME-}" ] && ')
    expect(command).toContain('/bin/sh "${HOME-}/.orca/agent-hooks/claude-hook.sh"')
    expect(command).toContain('ORCA_HOOK_AGENT_PID="${PPID:-}"')
    expect(command).not.toMatch(/powershell|OSTYPE|\/home\/test/i)
  })

  it('leaves every other event on the full wrapper', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    expect(getManagedEventHook('Stop', SCRIPT_PATH)).toEqual(
      getManagedLifecycleHook(SCRIPT_PATH, CLAUDE_HOOK_SETTINGS)
    )
  })

  it('keeps the Windows launcher on win32, whose bare script path is already short', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const windowsPath = 'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd'
    expect(getManagedEventHook('PostCompact', windowsPath)).toEqual(
      getManagedLifecycleHook(windowsPath, CLAUDE_HOOK_SETTINGS)
    )
  })

  // Why every client platform: a remote host is POSIX even when Orca runs on Windows.
  it.each(['darwin', 'linux', 'win32'] as const)(
    'uses the short POSIX form only for remote PostCompact from %s',
    (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
      expect(getRemoteManagedEventCommand('PostCompact', SCRIPT_PATH)).toBe(
        wrapRuntimeHomePosixHookCommand('claude-hook')
      )
      expect(getRemoteManagedEventCommand('Stop', SCRIPT_PATH)).toBe(
        getRemoteManagedCommand(SCRIPT_PATH)
      )
    }
  )
})

describe.skipIf(process.platform === 'win32')('PostCompact command execution', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-post-compact-'))
  })

  afterEach(() => rmSync(home, { recursive: true, force: true }))

  function run(command: string, env: NodeJS.ProcessEnv) {
    return runProcess({
      program: '/bin/sh',
      args: ['-c', command],
      env: { PATH: '/usr/bin:/bin', ...env },
      input: 'x'.repeat(1_000_000),
      timeoutMs: 5_000
    })
  }

  it('runs the HOME script with the agent pid captured', async () => {
    const dir = join(home, '.orca', 'agent-hooks')
    mkdirSync(dir, { recursive: true })
    const script = join(dir, 'claude-hook.sh')
    writeFileSync(script, '#!/bin/sh\ncat >/dev/null\nprintf "%s" "$ORCA_HOOK_AGENT_PID"\nexit 7\n')
    chmodSync(script, 0o755)

    const result = await run(getManagedEventHook('PostCompact', SCRIPT_PATH).command, {
      HOME: home
    })

    expect(result.code, result.stderr).toBe(7)
    expect(result.stdout).toBe(String(process.pid))
  })

  it.each([
    ['the script is missing', (dir: string) => ({ HOME: dir })],
    ['HOME is empty', () => ({ HOME: '' })],
    ['HOME is unset', () => ({})]
  ])('drains stdin silently when %s', async (_label, env) => {
    const result = await run(getManagedEventHook('PostCompact', SCRIPT_PATH).command, env(home))

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it.each([{}, { HOME: '' }])('skips script lookup without a runtime HOME: %j', async (env) => {
    const lookupProbe = [
      'probe_test() {',
      '  case "$1" in -f|-r|-x) printf "unexpected script lookup: %s\\n" "$2" >&2; return 1 ;;',
      '    *) command [ "$@" ;; esac',
      '}',
      'alias [=probe_test',
      getManagedEventHook('PostCompact', SCRIPT_PATH).command
    ].join('\n')

    const result = await run(lookupProbe, env)

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })
})

describe.skipIf(process.platform === 'win32')('ClaudeHookService PostCompact install', () => {
  it('writes the short form, reports installed, and replaces an old full-wrapper entry', () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-post-compact-install-'))
    vi.stubEnv('HOME', home)
    try {
      const settingsPath = join(home, '.claude', 'settings.json')
      mkdirSync(join(home, '.claude'), { recursive: true })
      const fullWrapper = getManagedLifecycleHook(SCRIPT_PATH).command
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            PostCompact: [{ hooks: [{ type: 'command', command: fullWrapper }] }]
          }
        })
      )

      const status = new ClaudeHookService().install(CURRENT_CLAUDE)

      expect(status.state).toBe('installed')
      const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(written.hooks.PostCompact).toEqual([
        { hooks: [getManagedEventHook('PostCompact', SCRIPT_PATH)] }
      ])
      expect(written.hooks.Stop[0].hooks[0].command).toBe(fullWrapper)
    } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('ClaudeHookService remote PostCompact install', () => {
  it('writes the short form for PostCompact and the full wrapper elsewhere', async () => {
    const { sftp, fs } = createAgentHookMemorySftp()
    await new ClaudeHookService().installRemote(sftp, '/home/dev', CURRENT_CLAUDE)

    const written = JSON.parse(fs.files.get('/home/dev/.claude/settings.json') ?? '{}')
    const remoteScript = '/home/dev/.orca/agent-hooks/claude-hook.sh'
    expect(written.hooks.PostCompact[0].hooks[0].command).toBe(
      getRemoteManagedEventCommand('PostCompact', remoteScript)
    )
    expect(written.hooks.Stop[0].hooks[0].command).toBe(getRemoteManagedCommand(remoteScript))
  })
})
