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
import { ClaudeHookService } from './hook-service'
import { CLAUDE_EVENTS } from './claude-managed-hook-events'
import { getWindowsManagedLifecycleHook, OPENCLAUDE_HOOK_SETTINGS } from './hook-settings'

const CLAUDE_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh'
const OPENCLAUDE_SCRIPT_FILE_NAME =
  process.platform === 'win32' ? 'openclaude-hook.cmd' : 'openclaude-hook.sh'
const isClaudeManagedCommand = createManagedCommandMatcher(CLAUDE_SCRIPT_FILE_NAME)
const isOpenClaudeManagedCommand = createManagedCommandMatcher(OPENCLAUDE_SCRIPT_FILE_NAME)

type TestHook = { command: string; args?: string[] }

const CURRENT_CLAUDE = { claudeVersion: '2.1.261 (Claude Code)' }

function hasManagedCommand(hook: TestHook, matcher: (command: string | undefined) => boolean) {
  return matcher(hook.command) || hook.args?.some(matcher) === true
}

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
})

describe('ClaudeHookService.installRemote', () => {
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
})
