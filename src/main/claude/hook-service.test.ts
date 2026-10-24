import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, describe, expect, it } from 'vitest'
import type * as GitBashModule from '../git-bash'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

const { gitBashAvailableMock } = vi.hoisted(() => ({ gitBashAvailableMock: { value: true } }))
vi.mock('../git-bash', async (importOriginal) => ({
  ...(await importOriginal<typeof GitBashModule>()),
  isGitBashAvailable: () => gitBashAvailableMock.value
}))

import type { SFTPWrapper } from 'ssh2'
import { createManagedCommandMatcher, WINDOWS_CMD_SAFE_PATH } from '../agent-hooks/installer-utils'
import { WINDOWS_HOOK_STDIN_DRAIN_LABEL } from '../agent-hooks/hook-stdin-contract'
import { ClaudeHookService } from './hook-service'
import { CLAUDE_EVENTS } from './claude-managed-hook-events'
import { getWindowsManagedLifecycleHook, OPENCLAUDE_HOOK_SETTINGS } from './hook-settings'

const CLAUDE_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh'
const STATUSLINE_SCRIPT_FILE_NAME =
  process.platform === 'win32' ? 'claude-statusline.cmd' : 'claude-statusline.sh'
const OPENCLAUDE_SCRIPT_FILE_NAME =
  process.platform === 'win32' ? 'openclaude-hook.cmd' : 'openclaude-hook.sh'
const isClaudeManagedCommand = createManagedCommandMatcher(CLAUDE_SCRIPT_FILE_NAME)
const isOpenClaudeManagedCommand = createManagedCommandMatcher(OPENCLAUDE_SCRIPT_FILE_NAME)

type TestHook = { command: string; args?: string[] }

const CURRENT_CLAUDE = { claudeVersion: '2.1.261 (Claude Code)' }

function hasManagedCommand(hook: TestHook, matcher: (command: string | undefined) => boolean) {
  return matcher(hook.command) || hook.args?.some(matcher) === true
}

describe('getWindowsManagedLifecycleHook', () => {
  const SAFE_SCRIPT_PATH = 'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd'
  const UNSAFE_SCRIPT_PATH = 'C:\\Users\\%name%\\a^b&c\\.orca\\agent-hooks\\claude-hook.cmd'

  it('registers the script itself, with no interpreter in front of it (#18875)', () => {
    const hook = getWindowsManagedLifecycleHook(SAFE_SCRIPT_PATH)

    expect(hook.args).toBeUndefined()
    expect(hook.command).toBe('C:/Users/alice/.orca/agent-hooks/claude-hook.cmd')
    expect(hook.command).not.toMatch(/powershell|-EncodedCommand|conhost/i)
    expect(hook.command).not.toMatch(/\\/)
    expect(hook.command).not.toMatch(/ \/[a-zA-Z]+( |$)/)
  })

  it('falls back to the encoded launcher when the profile path is not cmd-safe', () => {
    const hook = getWindowsManagedLifecycleHook(UNSAFE_SCRIPT_PATH)

    expect(hook.args).toBeUndefined()
    expect(hook.command).toMatch(/\/powershell\.exe -NoProfile -EncodedCommand /)
    expect(hook.command).not.toContain(UNSAFE_SCRIPT_PATH)
    expect(hook.command.replace(/-EncodedCommand \S+$/, '')).not.toMatch(/\\| \/[a-zA-Z]+( |$)/)

    const encoded = hook.command.match(/-EncodedCommand (\S+)$/)?.[1]
    const decoded = Buffer.from(encoded ?? '', 'base64').toString('utf16le')
    expect(decoded).toContain('$env:USERPROFILE')
    expect(decoded).toContain('.orca\\agent-hooks\\claude-hook.cmd')
  })

  it('does not consult Git Bash availability', () => {
    gitBashAvailableMock.value = false
    try {
      expect(getWindowsManagedLifecycleHook(SAFE_SCRIPT_PATH).command).toBe(
        'C:/Users/alice/.orca/agent-hooks/claude-hook.cmd'
      )
    } finally {
      gitBashAvailableMock.value = true
    }
  })

  it('is still recognized as managed by createManagedCommandMatcher (#14825)', () => {
    for (const hook of [
      getWindowsManagedLifecycleHook(SAFE_SCRIPT_PATH),
      getWindowsManagedLifecycleHook(UNSAFE_SCRIPT_PATH)
    ]) {
      expect(isClaudeManagedCommand(hook.command)).toBe(true)
    }
  })
})

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
}

function createFakeSftp(): { sftp: SFTPWrapper; fs: FakeFs } {
  const fs: FakeFs = {
    files: new Map(),
    dirs: new Set(['/']),
    modes: new Map()
  }
  const noEntryError = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })
  const fakeStats = (mode: number): { mode: number } => ({ mode })
  const sftp = {
    readFile: (path: string, _enc: string, cb: (err: unknown, data?: string) => void): void => {
      const v = fs.files.get(path)
      if (v === undefined) {
        cb(noEntryError(path))
        return
      }
      cb(null, v)
    },
    writeFile: (
      path: string,
      content: string,
      options: string | { mode?: number },
      cb: (err: unknown) => void
    ): void => {
      fs.files.set(path, content)
      if (typeof options !== 'string' && options.mode !== undefined) {
        fs.modes.set(path, options.mode)
      }
      cb(null)
    },
    rename: (src: string, dst: string, cb: (err: unknown) => void): void => {
      const v = fs.files.get(src)
      if (v === undefined) {
        cb(noEntryError(src))
        return
      }
      fs.files.set(dst, v)
      fs.files.delete(src)
      const mode = fs.modes.get(src)
      if (mode !== undefined) {
        fs.modes.set(dst, mode)
        fs.modes.delete(src)
      }
      cb(null)
    },
    unlink: (path: string, cb: (err: unknown) => void): void => {
      fs.files.delete(path)
      fs.modes.delete(path)
      cb(null)
    },
    chmod: (path: string, mode: number, cb: (err: unknown) => void): void => {
      fs.modes.set(path, mode)
      cb(null)
    },
    stat: (path: string, cb: (err: unknown, stats?: { mode: number }) => void): void => {
      if (!fs.files.has(path)) {
        cb(noEntryError(path))
        return
      }
      cb(null, fakeStats(fs.modes.get(path) ?? 0o100644))
    },
    readdir: (path: string, cb: (err: unknown, list?: { filename: string }[]) => void): void => {
      if (fs.dirs.has(path)) {
        cb(null, [])
        return
      }
      cb(noEntryError(path))
    },
    mkdir: (path: string, cb: (err: unknown) => void): void => {
      fs.dirs.add(path)
      cb(null)
    }
  } as unknown as SFTPWrapper
  return { sftp, fs }
}

describe('ClaudeHookService.install', () => {
  it('installs managed hooks into Claude settings and preserves user Bedrock settings', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-hooks-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const legacyPath = join(tmpHome, '.claude', 'settings.json')
      mkdirSync(join(tmpHome, '.claude'), { recursive: true })
      writeFileSync(
        legacyPath,
        JSON.stringify({
          apiKeyHelper: '/opt/company/claude-key-helper',
          awsAuthRefresh: '/opt/company/aws-refresh',
          awsCredentialExport: '/opt/company/aws-export',
          env: {
            CLAUDE_CODE_USE_BEDROCK: '1',
            AWS_REGION: 'us-west-2'
          },
          hooks: {
            Stop: [
              {
                hooks: [{ type: 'command', command: '/usr/local/bin/user-hook' }]
              },
              {
                hooks: [
                  {
                    type: 'command',
                    command: '/Users/old/.orca/agent-hooks/claude-hook.sh'
                  }
                ]
              }
            ]
          }
        })
      )

      const status = new ClaudeHookService().install(CURRENT_CLAUDE)
      expect(status.state).toBe('installed')

      const legacy = JSON.parse(readFileSync(legacyPath, 'utf-8'))
      expect(legacy).toMatchObject({
        apiKeyHelper: '/opt/company/claude-key-helper',
        awsAuthRefresh: '/opt/company/aws-refresh',
        awsCredentialExport: '/opt/company/aws-export',
        env: {
          CLAUDE_CODE_USE_BEDROCK: '1',
          AWS_REGION: 'us-west-2'
        }
      })
      const legacyHooks = legacy.hooks.Stop.flatMap(
        (definition: { hooks: TestHook[] }) => definition.hooks
      )
      expect(legacyHooks.map((hook: TestHook) => hook.command)).toContain(
        '/usr/local/bin/user-hook'
      )
      const managedHook = legacyHooks.find((hook: TestHook) =>
        hasManagedCommand(hook, isClaudeManagedCommand)
      )
      // POSIX resolves HOME at runtime; Windows registers an absolute path shared by its shells.
      if (process.platform !== 'win32') {
        expect(JSON.stringify(managedHook)).not.toContain(tmpHome.replaceAll('\\', '/'))
      }
      expect(
        legacyHooks.some((hook: TestHook) => hasManagedCommand(hook, isClaudeManagedCommand))
      ).toBe(true)
      expect(
        legacyHooks.some((hook: TestHook) =>
          hook.command.includes('/Users/old/.orca/agent-hooks/claude-hook.sh')
        )
      ).toBe(false)
      expect(hasManagedCommand(legacy.hooks.StopFailure[0].hooks[0], isClaudeManagedCommand)).toBe(
        true
      )
      const managedScript = readFileSync(
        join(
          tmpHome,
          '.orca',
          'agent-hooks',
          process.platform === 'win32' ? 'claude-hook-impl.cmd' : CLAUDE_SCRIPT_FILE_NAME
        ),
        'utf-8'
      )
      expect(managedScript).toContain('DEVIN_PROJECT_DIR')
      expect(managedScript).toContain('GROK_HOOK_EVENT')
      expect(managedScript).toMatch(
        process.platform === 'win32'
          ? /^@echo off\r\nsetlocal\r\necho \{\}\r\n/
          : /^#!\/bin\/sh\nprintf "\{\}\\n"\n/
      )
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('writes only the events an old resolved Claude knows and reports that as installed', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-old-version-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const service = new ClaudeHookService()
      expect(service.install({ claudeVersion: '2.1.32' }).state).toBe('installed')

      const settings = JSON.parse(readFileSync(join(tmpHome, '.claude', 'settings.json'), 'utf-8'))
      for (const event of ['StopFailure', 'PostCompact', 'TeammateIdle', 'SessionEnd']) {
        expect(settings.hooks[event], event).toBeUndefined()
      }
      expect(settings.hooks.SubagentStart).toBeDefined()
      expect(service.getStatus().state).toBe('installed')
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('keeps newer Orca events and reports installed when a later probe cannot resolve the version', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-unknown-version-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const service = new ClaudeHookService()
      const settingsPath = join(tmpHome, '.claude', 'settings.json')
      expect(service.install(CURRENT_CLAUDE).state).toBe('installed')
      const known = JSON.parse(readFileSync(settingsPath, 'utf-8'))

      expect(service.install().state).toBe('installed')

      const unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(unknown.hooks).toEqual(known.hooks)
      expect(service.getStatus().state).toBe('installed')
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('installs the managed statusLine command and forwards rate_limits posts', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-statusline-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      expect(new ClaudeHookService().install().state).toBe('installed')

      const settings = JSON.parse(
        readFileSync(join(tmpHome, '.claude', 'settings.json'), 'utf-8')
      ) as { statusLine?: { type: string; command: string } }
      expect(settings.statusLine?.type).toBe('command')
      if (process.platform !== 'win32') {
        expect(settings.statusLine?.command).toContain(
          '"${HOME-}/.orca/agent-hooks/claude-statusline.sh"'
        )
        expect(settings.statusLine?.command).not.toContain(tmpHome)
      }

      const script = readFileSync(
        join(tmpHome, '.orca', 'agent-hooks', STATUSLINE_SCRIPT_FILE_NAME),
        'utf-8'
      )
      expect(script).toContain('/statusline/claude')
      if (process.platform === 'win32') {
        expect(script).toContain('findstr.exe" /c:\\"rate_limits\\"')
        expect(script).toContain('--data-urlencode "payload@%ORCA_STATUSLINE_PAYLOAD_FILE%"')
      } else {
        expect(script).toContain('"rate_limits"')
        expect(script).toContain('--data-urlencode "payload@-"')
      }
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('never overwrites a user-owned statusLine command', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-user-statusline-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const settingsPath = join(tmpHome, '.claude', 'settings.json')
      mkdirSync(join(tmpHome, '.claude'), { recursive: true })
      writeFileSync(
        settingsPath,
        JSON.stringify({
          statusLine: {
            type: 'command',
            command: '/usr/local/bin/my-statusline'
          }
        })
      )

      expect(new ClaudeHookService().install().state).toBe('installed')

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(settings.statusLine).toEqual({
        type: 'command',
        command: '/usr/local/bin/my-statusline'
      })

      new ClaudeHookService().remove()
      const afterRemove = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(afterRemove.statusLine).toEqual({
        type: 'command',
        command: '/usr/local/bin/my-statusline'
      })
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('removes the managed statusLine on remove()', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-statusline-remove-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      new ClaudeHookService().install()
      new ClaudeHookService().remove()
      const settings = JSON.parse(readFileSync(join(tmpHome, '.claude', 'settings.json'), 'utf-8'))
      expect(settings.statusLine).toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('does not re-install a managed statusLine the user deleted, until remove() resets the opt-out', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-statusline-optout-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const settingsPath = join(tmpHome, '.claude', 'settings.json')
      new ClaudeHookService().install()
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeTruthy()

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      delete settings.statusLine
      writeFileSync(settingsPath, JSON.stringify(settings))

      new ClaudeHookService().install()
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeUndefined()

      new ClaudeHookService().remove()
      new ClaudeHookService().install()
      expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).statusLine).toBeTruthy()
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('keeps refreshing a still-managed statusLine across installs', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-statusline-refresh-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const settingsPath = join(tmpHome, '.claude', 'settings.json')
      new ClaudeHookService().install()
      new ClaudeHookService().install()
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
      expect(settings.statusLine?.command).toContain('claude-statusline')
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform !== 'win32')(
    'pins the encoded-launcher fallback for a profile path the shells cannot carry bare',
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'orca claude home with spaces '))
      vi.stubEnv('HOME', tmpHome)
      vi.stubEnv('USERPROFILE', tmpHome)
      try {
        expect(new ClaudeHookService().install().state).toBe('installed')

        const settings = JSON.parse(
          readFileSync(join(tmpHome, '.claude', 'settings.json'), 'utf-8')
        ) as { hooks: Record<string, { hooks: TestHook[] }[]> }

        const scriptPath = join(tmpHome, '.orca', 'agent-hooks', CLAUDE_SCRIPT_FILE_NAME)

        for (const eventName of ['UserPromptSubmit', 'Stop', 'StopFailure']) {
          const hook = settings.hooks[eventName]?.[0]?.hooks?.[0]
          expect(hook?.args).toBeUndefined()
          expect(hook?.command).toMatch(/\/powershell\.exe -NoProfile -EncodedCommand /)
          expect(hook?.command).not.toContain(scriptPath)

          const encoded = hook?.command.match(/-EncodedCommand (\S+)$/)?.[1]
          const decoded = Buffer.from(encoded ?? '', 'base64').toString('utf16le')
          expect(decoded).toContain('$env:USERPROFILE')
          expect(decoded).toContain(`.orca\\agent-hooks\\${CLAUDE_SCRIPT_FILE_NAME}`)
        }
      } finally {
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'installs the bare script path on every event when the profile path is cmd-safe (#18875)',
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-direct-'))
      vi.stubEnv('HOME', tmpHome)
      vi.stubEnv('USERPROFILE', tmpHome)
      const scriptPath = join(tmpHome, '.orca', 'agent-hooks', CLAUDE_SCRIPT_FILE_NAME)
      if (!WINDOWS_CMD_SAFE_PATH.test(scriptPath)) {
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
        return
      }
      try {
        expect(new ClaudeHookService().install(CURRENT_CLAUDE).state).toBe('installed')

        const settings = JSON.parse(
          readFileSync(join(tmpHome, '.claude', 'settings.json'), 'utf-8')
        ) as { hooks: Record<string, { hooks: TestHook[] }[]> }

        const expected = scriptPath.replaceAll('\\', '/')
        for (const { eventName } of CLAUDE_EVENTS) {
          const hook = settings.hooks[eventName]?.[0]?.hooks?.[0]
          expect(hook?.args, eventName).toBeUndefined()
          expect(hook?.command, eventName).toBe(expected)
        }
        expect(JSON.stringify(settings.hooks)).not.toMatch(/powershell|EncodedCommand/i)
        expect(new ClaudeHookService().getStatus(CURRENT_CLAUDE).state).toBe('installed')
      } finally {
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'sweeps a previously installed encoded launcher on reinstall, keeping user hooks',
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-migrate-'))
      vi.stubEnv('HOME', tmpHome)
      vi.stubEnv('USERPROFILE', tmpHome)
      const scriptPath = join(tmpHome, '.orca', 'agent-hooks', CLAUDE_SCRIPT_FILE_NAME)
      if (!WINDOWS_CMD_SAFE_PATH.test(scriptPath)) {
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
        return
      }
      try {
        const settingsPath = join(tmpHome, '.claude', 'settings.json')
        mkdirSync(join(tmpHome, '.claude'), { recursive: true })
        const stale = getWindowsManagedLifecycleHook(
          'C:\\Users\\%name%\\.orca\\agent-hooks\\claude-hook.cmd'
        )
        writeFileSync(
          settingsPath,
          JSON.stringify({
            hooks: {
              Stop: [{ hooks: [stale] }],
              PreToolUse: [{ matcher: '*', hooks: [stale] }],
              UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo mine' }] }]
            }
          }),
          'utf-8'
        )

        expect(new ClaudeHookService().install().state).toBe('installed')

        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
          hooks: Record<string, { hooks: TestHook[] }[]>
        }
        expect(JSON.stringify(settings.hooks)).not.toContain('-EncodedCommand')
        expect(
          settings.hooks.UserPromptSubmit.some((definition) =>
            definition.hooks.some((hook) => hook.command === 'echo mine')
          )
        ).toBe(true)
      } finally {
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'reports a stale absolute path as not_installed and rewrites it on install (#18875)',
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-moved-'))
      vi.stubEnv('HOME', tmpHome)
      vi.stubEnv('USERPROFILE', tmpHome)
      const scriptPath = join(tmpHome, '.orca', 'agent-hooks', CLAUDE_SCRIPT_FILE_NAME)
      if (!WINDOWS_CMD_SAFE_PATH.test(scriptPath)) {
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
        return
      }
      try {
        const settingsPath = join(tmpHome, '.claude', 'settings.json')
        mkdirSync(join(tmpHome, '.claude'), { recursive: true })
        const staleCommand = 'C:/Users/someone-else/.orca/agent-hooks/claude-hook.cmd || echo {}'
        const stale = { type: 'command', command: staleCommand, timeout: 10 }
        writeFileSync(
          settingsPath,
          JSON.stringify({
            hooks: Object.fromEntries(
              CLAUDE_EVENTS.map(({ eventName }) => [eventName, [{ hooks: [stale] }]])
            )
          }),
          'utf-8'
        )

        expect(new ClaudeHookService().getStatus().state).toBe('not_installed')
        expect(new ClaudeHookService().install().state).toBe('installed')

        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8')) as {
          hooks: Record<string, { hooks: TestHook[] }[]>
        }
        expect(JSON.stringify(settings.hooks)).not.toContain('someone-else')
        expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(scriptPath.replaceAll('\\', '/'))
        expect(new ClaudeHookService().getStatus().state).toBe('installed')
      } finally {
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'posts from the managed .cmd via curl.exe, not a second PowerShell',
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-curl-'))
      vi.stubEnv('HOME', tmpHome)
      vi.stubEnv('USERPROFILE', tmpHome)
      try {
        expect(new ClaudeHookService().install().state).toBe('installed')
        const script = readFileSync(
          join(tmpHome, '.orca', 'agent-hooks', 'claude-hook-impl.cmd'),
          'utf-8'
        )
        expect(script).toContain('%SystemRoot%\\System32\\curl.exe')
        expect(script).toContain('--data-urlencode "payload@-"')
        expect(script).toContain('/hook/claude')
        expect(script).not.toMatch(/Invoke-WebRequest/i)
        expect(script.split('\r\n')[2]).toBe('echo {}')
      } finally {
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
      }
    }
  )
})

describe('backgrounded-session pane guard (#9236)', () => {
  // Daemon workers inherit stale pane keys; CLAUDE_JOB_DIR identifies their unattributable hooks.
  it('declines to post from a daemon worker, before spawning curl', async () => {
    const { sftp, fs } = createFakeSftp()
    expect((await new ClaudeHookService().installRemote(sftp, '/home/dev')).state).toBe('installed')
    const script = fs.files.get('/home/dev/.orca/agent-hooks/claude-hook.sh')!

    expect(script).toContain('if [ -n "$CLAUDE_JOB_DIR" ]; then')
    expect(script.indexOf('CLAUDE_JOB_DIR')).toBeLessThan(script.indexOf('curl'))
    expect(script.indexOf('printf "{}\\n"')).toBeLessThan(script.indexOf('CLAUDE_JOB_DIR'))
  })

  it('guards the statusline too, on both branches', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    for (const target of ['darwin', 'win32'] as const) {
      const tmpHome = mkdtempSync(join(tmpdir(), `orca-claude-sl-${target}-`))
      Object.defineProperty(process, 'platform', { value: target, configurable: true })
      vi.stubEnv('HOME', tmpHome)
      vi.stubEnv('USERPROFILE', tmpHome)
      try {
        expect(new ClaudeHookService().install().state).toBe('installed')
        const script = readFileSync(
          join(
            tmpHome,
            '.orca',
            'agent-hooks',
            target === 'win32' ? 'claude-statusline.cmd' : 'claude-statusline.sh'
          ),
          'utf-8'
        )
        const guard = script
          .split(target === 'win32' ? '\r\n' : '\n')
          .find((line) => line.includes('CLAUDE_JOB_DIR'))
        expect(guard).toBeDefined()
        expect(script.indexOf('CLAUDE_JOB_DIR')).toBeLessThan(script.indexOf('curl'))
        if (target === 'win32') {
          expect(guard).not.toContain(WINDOWS_HOOK_STDIN_DRAIN_LABEL)
        }
      } finally {
        Object.defineProperty(process, 'platform', platform)
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
      }
    }
  })

  it('exits rather than draining stdin on Windows, where a worker has no Orca pane', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-bg-'))
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      expect(new ClaudeHookService().install().state).toBe('installed')
      const script = readFileSync(
        join(tmpHome, '.orca', 'agent-hooks', 'claude-hook-impl.cmd'),
        'utf-8'
      )
      const guard = script.split('\r\n').find((line) => line.includes('CLAUDE_JOB_DIR'))
      expect(guard).toBe('if not "%CLAUDE_JOB_DIR%"=="" exit /b 0')
      expect(guard).not.toContain(WINDOWS_HOOK_STDIN_DRAIN_LABEL)
    } finally {
      Object.defineProperty(process, 'platform', platform)
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

describe('ClaudeHookService.installRemote', () => {
  it('writes Claude settings + managed script under the remote $HOME', async () => {
    const svc = new ClaudeHookService()
    const { sftp, fs } = createFakeSftp()
    const status = await svc.installRemote(sftp, '/home/dev', CURRENT_CLAUDE)
    expect(status.state).toBe('installed')
    expect(status.configPath).toBe('/home/dev/.claude/settings.json')
    const settings = fs.files.get('/home/dev/.claude/settings.json')
    expect(settings).toBeTruthy()
    const parsed = JSON.parse(settings!)
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'StopFailure',
      'SubagentStart',
      'SubagentStop',
      'TeammateIdle',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest'
    ]) {
      expect(parsed.hooks[event]).toBeTruthy()
      const cmd = parsed.hooks[event][0].hooks[0].command as string
      expect(cmd).toContain('"${HOME-}/.orca/agent-hooks/claude-hook.sh"')
      expect(cmd).not.toContain('/home/dev/.orca/agent-hooks/claude-hook.sh')
    }
    const script = fs.files.get('/home/dev/.orca/agent-hooks/claude-hook.sh')
    expect(script).toContain('#!/bin/sh')
    expect(script).toContain('DEVIN_PROJECT_DIR')
    expect(script).toContain('GROK_HOOK_EVENT')
    expect(script!.indexOf('printf "{}\\n"')).toBe(
      script!.indexOf('#!/bin/sh') + '#!/bin/sh\n'.length
    )
    expect(script).toContain('printf \'%s\' "$payload" | LC_ALL= LC_NUMERIC=C curl')
    expect(script).toContain('-H "Content-Type: application/json"')
    expect(script).toContain('orca_hook_metadata=$(printf')
    expect(script).toContain('unset ORCA_AGENT_HOOK_TRANSPORT')
    expect(script).toContain('-H "X-Orca-Agent-Hook-Meta: ${orca_hook_metadata}"')
    expect(script).toContain('--data-binary @-')
    expect(script).toContain('--data-urlencode "payload@-"')
    expect(fs.modes.get('/home/dev/.orca/agent-hooks/claude-hook.sh')).toBe(0o755)
    expect(parsed.statusLine).toBeUndefined()
    expect(fs.files.get('/home/dev/.orca/agent-hooks/claude-statusline.sh')).toBeUndefined()
  })

  it('writes only the events the remote Claude knows, adding newer ones once it upgrades', async () => {
    const svc = new ClaudeHookService()
    const { sftp, fs } = createFakeSftp()
    const settingsPath = '/home/dev/.claude/settings.json'
    const userStop = { hooks: [{ type: 'command', command: '/usr/local/bin/my-user-hook' }] }
    fs.files.set(settingsPath, JSON.stringify({ env: { A: '1' }, hooks: { Stop: [userStop] } }))

    await svc.installRemote(sftp, '/home/dev', { claudeVersion: '2.1.77' })
    const old = JSON.parse(fs.files.get(settingsPath)!)
    expect(old.hooks.StopFailure).toBeUndefined()
    expect(old.hooks.PostCompact).toBeDefined()

    await svc.installRemote(sftp, '/home/dev', { claudeVersion: '2.1.78' })
    const upgraded = JSON.parse(fs.files.get(settingsPath)!)
    expect(upgraded.hooks.StopFailure[0].hooks[0].command).toContain('claude-hook.sh')
    expect(upgraded.hooks.Stop[0]).toEqual(userStop)
    expect(upgraded.env).toEqual({ A: '1' })
  })

  it('reports parse error when remote settings.json cannot be parsed', async () => {
    const svc = new ClaudeHookService()
    const { sftp, fs } = createFakeSftp()
    fs.files.set('/home/dev/.claude/settings.json', 'not json')
    const status = await svc.installRemote(sftp, '/home/dev')
    expect(status.state).toBe('error')
    expect(status.managedHooksPresent).toBe(false)
    expect(status.detail).toContain('Could not parse remote Claude settings.json')
  })

  it('preserves user-authored hook entries while sweeping old managed entries', async () => {
    const svc = new ClaudeHookService()
    const { sftp, fs } = createFakeSftp()
    fs.files.set(
      '/home/dev/.claude/settings.json',
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [{ type: 'command', command: '/usr/local/bin/my-user-hook' }]
            },
            {
              hooks: [
                {
                  type: 'command',
                  command:
                    'if [ -x /home/dev/.orca/agent-hooks/claude-hook.sh ]; then /bin/sh /home/dev/.orca/agent-hooks/claude-hook.sh; fi'
                }
              ]
            }
          ]
        }
      })
    )
    await svc.installRemote(sftp, '/home/dev')
    const parsed = JSON.parse(fs.files.get('/home/dev/.claude/settings.json')!)
    const stopDefs = parsed.hooks.Stop as { hooks: { command: string }[] }[]
    const userCmds = stopDefs.flatMap((d) => d.hooks.map((h) => h.command))
    expect(userCmds).toContain('/usr/local/bin/my-user-hook')
    expect(userCmds.filter((c) => c.includes('claude-hook.sh'))).toHaveLength(1)
  })
})

describe('OpenClaudeHookService-compatible install', () => {
  const makeOpenClaudeService = (): ClaudeHookService =>
    new ClaudeHookService({
      agent: 'openclaude',
      displayName: 'OpenClaude',
      settings: OPENCLAUDE_HOOK_SETTINGS
    })

  it('installs managed hooks into OpenClaude settings without touching Claude settings', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-openclaude-hooks-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const openClaudeSettings = join(tmpHome, '.openclaude', 'settings.json')
      mkdirSync(join(tmpHome, '.openclaude'), { recursive: true })
      writeFileSync(openClaudeSettings, JSON.stringify({ hooks: {} }))

      const status = makeOpenClaudeService().install()

      expect(status).toMatchObject({
        agent: 'openclaude',
        state: 'installed',
        configPath: openClaudeSettings
      })
      const parsed = JSON.parse(readFileSync(openClaudeSettings, 'utf-8'))
      for (const event of ['UserPromptSubmit', 'Stop', 'StopFailure']) {
        const command = parsed.hooks[event][0].hooks[0].command as string
        expect(isOpenClaudeManagedCommand(command)).toBe(true)
        expect(command).toContain('"${HOME-}/.orca/agent-hooks/openclaude-hook.cmd"')
        expect(command).toContain('"${HOME-}/.orca/agent-hooks/openclaude-hook.sh"')
        expect(command).not.toContain(tmpHome.replaceAll('\\', '/'))
      }
      expect(
        readFileSync(join(tmpHome, '.orca', 'agent-hooks', OPENCLAUDE_SCRIPT_FILE_NAME), 'utf-8')
      ).toContain('/hook/claude')
      expect(
        readFileSync(join(tmpHome, '.orca', 'agent-hooks', OPENCLAUDE_SCRIPT_FILE_NAME), 'utf-8')
      ).not.toContain('DEVIN_PROJECT_DIR')
      expect(
        readFileSync(join(tmpHome, '.orca', 'agent-hooks', OPENCLAUDE_SCRIPT_FILE_NAME), 'utf-8')
      ).not.toContain('GROK_HOOK_EVENT')
      expect(parsed.statusLine).toBeUndefined()
      expect(existsSync(join(tmpHome, '.claude', 'settings.json'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('writes remote OpenClaude settings under .openclaude', async () => {
    const { sftp, fs } = createFakeSftp()

    const status = await makeOpenClaudeService().installRemote(sftp, '/home/dev')

    expect(status).toMatchObject({
      agent: 'openclaude',
      state: 'installed',
      configPath: '/home/dev/.openclaude/settings.json'
    })
    const parsed = JSON.parse(fs.files.get('/home/dev/.openclaude/settings.json')!)
    const command = parsed.hooks.StopFailure[0].hooks[0].command as string
    expect(command).toContain('"${HOME-}/.orca/agent-hooks/openclaude-hook.sh"')
    expect(command).not.toContain('/home/dev/.orca/agent-hooks/openclaude-hook.sh')
    expect(fs.files.get('/home/dev/.orca/agent-hooks/openclaude-hook.sh')).toContain('/hook/claude')
  })
})
