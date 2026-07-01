// Why: locks in the remote-install contract so a refactor cannot silently
// drift the produced settings.json shape, the wrapper-quoted command path,
// or the script body that lands on the remote box. Local install behavior
// is exercised through `installer-utils.test.ts` and the per-CLI status
// audit; this file covers ONLY the SFTP-backed path added in commit #8.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, describe, expect, it } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

import type { SFTPWrapper } from 'ssh2'
import { ClaudeHookService } from './hook-service'
import { OPENCLAUDE_HOOK_SETTINGS } from './hook-settings'

const CLAUDE_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh'
const OPENCLAUDE_SCRIPT_FILE_NAME =
  process.platform === 'win32' ? 'openclaude-hook.cmd' : 'openclaude-hook.sh'
const WINDOWS_POWERSHELL_LAUNCHER =
  /^[A-Za-z]:\/[^"]*\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand \S+$/

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

      const status = new ClaudeHookService().install()
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
      const legacyCommands = legacy.hooks.Stop.flatMap(
        (definition: { hooks: { command: string }[] }) =>
          definition.hooks.map((hook) => hook.command)
      )
      expect(legacyCommands).toContain('/usr/local/bin/user-hook')
      expect(
        legacyCommands.some((command: string) =>
          process.platform === 'win32'
            ? WINDOWS_POWERSHELL_LAUNCHER.test(command)
            : command.includes(CLAUDE_SCRIPT_FILE_NAME)
        )
      ).toBe(true)
      expect(
        legacyCommands.some((command: string) =>
          command.includes('/Users/old/.orca/agent-hooks/claude-hook.sh')
        )
      ).toBe(false)
      expect(legacy.hooks.StopFailure[0].hooks[0].command).toMatch(
        process.platform === 'win32'
          ? WINDOWS_POWERSHELL_LAUNCHER
          : new RegExp(CLAUDE_SCRIPT_FILE_NAME)
      )
      expect(
        readFileSync(join(tmpHome, '.orca', 'agent-hooks', CLAUDE_SCRIPT_FILE_NAME), 'utf-8')
      ).toContain('DEVIN_PROJECT_DIR')
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  // Why: #6078 — Claude Code runs hooks through Git Bash, and an unquoted path
  // with a space (e.g. `C:/Users/Jane Doe`) splits at the space. The managed
  // command must use an encoded launcher so Git Bash/cmd.exe never splits or
  // expands the raw path before invoking the managed .cmd.
  it.skipIf(process.platform !== 'win32')(
    'wraps the managed hook command to survive spaces in the profile path (#6078)',
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'orca claude home with spaces '))
      vi.stubEnv('HOME', tmpHome)
      vi.stubEnv('USERPROFILE', tmpHome)
      try {
        expect(new ClaudeHookService().install().state).toBe('installed')

        const settings = JSON.parse(
          readFileSync(join(tmpHome, '.claude', 'settings.json'), 'utf-8')
        ) as { hooks: Record<string, { hooks: { command: string }[] }[]> }

        for (const eventName of ['UserPromptSubmit', 'Stop', 'StopFailure']) {
          const command = settings.hooks[eventName]?.[0]?.hooks?.[0]?.command
          expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
        }
      } finally {
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
      }
    }
  )

  // Why: the launcher must stay PowerShell-encoded for Git Bash, but the hook
  // POST inside the .cmd should use curl.exe so each hook spawns one
  // interpreter, not two. Posting via a second PowerShell was the slow path.
  it.skipIf(process.platform !== 'win32')(
    'posts from the managed .cmd via curl.exe, not a second PowerShell',
    () => {
      const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-curl-'))
      vi.stubEnv('HOME', tmpHome)
      vi.stubEnv('USERPROFILE', tmpHome)
      try {
        expect(new ClaudeHookService().install().state).toBe('installed')
        const script = readFileSync(
          join(tmpHome, '.orca', 'agent-hooks', CLAUDE_SCRIPT_FILE_NAME),
          'utf-8'
        )
        expect(script).toContain('%SystemRoot%\\System32\\curl.exe')
        expect(script).toContain('--data-urlencode "payload@-"')
        expect(script).toContain('/hook/claude')
        expect(script).not.toMatch(/Invoke-WebRequest/i)
      } finally {
        vi.unstubAllEnvs()
        rmSync(tmpHome, { recursive: true, force: true })
      }
    }
  )
})

describe('ClaudeHookService.installRemote', () => {
  it('writes Claude settings + managed script under the remote $HOME', async () => {
    const svc = new ClaudeHookService()
    const { sftp, fs } = createFakeSftp()
    const status = await svc.installRemote(sftp, '/home/dev')
    expect(status.state).toBe('installed')
    expect(status.configPath).toBe('/home/dev/.claude/settings.json')
    const settings = fs.files.get('/home/dev/.claude/settings.json')
    expect(settings).toBeTruthy()
    const parsed = JSON.parse(settings!)
    // Why: every load-bearing event must be present and point at the
    // remote-shaped script path with the `if [ -x ... ]; then ... fi`
    // wrapper applied. Drift in any of these is a real bug — Claude
    // Code rejects unknown shapes silently and the agent-hooks pipeline
    // goes dark.
    for (const event of [
      'UserPromptSubmit',
      'Stop',
      'StopFailure',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest'
    ]) {
      expect(parsed.hooks[event]).toBeTruthy()
      const cmd = parsed.hooks[event][0].hooks[0].command as string
      expect(cmd).toContain('/home/dev/.orca/agent-hooks/claude-hook.sh')
      expect(cmd).toMatch(/^if \[ -x /)
    }
    // Managed script body
    const script = fs.files.get('/home/dev/.orca/agent-hooks/claude-hook.sh')
    expect(script).toContain('#!/bin/sh')
    expect(script).toContain('DEVIN_PROJECT_DIR')
    expect(fs.modes.get('/home/dev/.orca/agent-hooks/claude-hook.sh')).toBe(0o755)
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
    // Original user-authored entry survives, while stale Orca entries are
    // replaced with the current managed hook command.
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
        if (process.platform === 'win32') {
          expect(command).toMatch(WINDOWS_POWERSHELL_LAUNCHER)
        } else {
          expect(command).toContain(OPENCLAUDE_SCRIPT_FILE_NAME)
          expect(command).toMatch(/^if \[ -x /)
        }
      }
      expect(
        readFileSync(join(tmpHome, '.orca', 'agent-hooks', OPENCLAUDE_SCRIPT_FILE_NAME), 'utf-8')
      ).toContain('/hook/claude')
      expect(
        readFileSync(join(tmpHome, '.orca', 'agent-hooks', OPENCLAUDE_SCRIPT_FILE_NAME), 'utf-8')
      ).not.toContain('DEVIN_PROJECT_DIR')
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
    expect(command).toContain('/home/dev/.orca/agent-hooks/openclaude-hook.sh')
    expect(fs.files.get('/home/dev/.orca/agent-hooks/openclaude-hook.sh')).toContain('/hook/claude')
  })
})
