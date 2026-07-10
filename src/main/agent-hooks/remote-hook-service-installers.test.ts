import { describe, expect, it, vi } from 'vitest'
import type { SFTPWrapper } from 'ssh2'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/orca-user-data'
  }
}))

import { CodexHookService } from '../codex/hook-service'
import { DroidHookService } from '../droid/hook-service'
import { CursorHookService } from '../cursor/hook-service'
import { CommandCodeHookService } from '../command-code/hook-service'
import { GeminiHookService } from '../gemini/hook-service'
import { AntigravityHookService } from '../antigravity/hook-service'
import { AmpHookService } from '../amp/hook-service'
import { ClaudeHookService } from '../claude/hook-service'
import { GrokHookService } from '../grok/hook-service'
import { CopilotHookService } from '../copilot/hook-service'
import { HermesHookService } from '../hermes/hook-service'
import { DevinHookService } from '../devin/hook-service'
import { KimiHookService } from '../kimi/hook-service'
import { openClaudeHookService } from '../openclaude/hook-service'
import { ampHookService } from '../amp/hook-service'
import { antigravityHookService } from '../antigravity/hook-service'
import { claudeHookService } from '../claude/hook-service'
import { codexHookService } from '../codex/hook-service'
import { copilotHookService } from '../copilot/hook-service'
import { cursorHookService } from '../cursor/hook-service'
import { droidHookService } from '../droid/hook-service'
import { commandCodeHookService } from '../command-code/hook-service'
import { geminiHookService } from '../gemini/hook-service'
import { devinHookService } from '../devin/hook-service'
import { grokHookService } from '../grok/hook-service'
import { hermesHookService } from '../hermes/hook-service'
import { kimiHookService } from '../kimi/hook-service'
import { MANAGED_AGENT_HOOK_INSTALLERS } from './managed-agent-hook-controls'
import {
  installRemoteManagedAgentHooks,
  REMOTE_MANAGED_HOOK_INSTALLER_AGENTS
} from './remote-managed-hook-installers'

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
  failRenameTo: Set<string>
}

function createFakeSftp(initialFiles: Record<string, string> = {}): {
  sftp: SFTPWrapper
  fs: FakeFs
} {
  const fs: FakeFs = {
    files: new Map(Object.entries(initialFiles)),
    dirs: new Set(['/']),
    modes: new Map(),
    failRenameTo: new Set()
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
      if (fs.failRenameTo.has(dst)) {
        cb({ code: 4, message: `rename failed ${dst}` })
        return
      }
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

describe('remote hook service installers', () => {
  it('always writes POSIX scripts for SSH remotes even from a Windows host', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      const installers = [
        {
          path: '/home/dev/.orca/agent-hooks/claude-hook.sh',
          install: (sftp: SFTPWrapper) => new ClaudeHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/openclaude-hook.sh',
          install: (sftp: SFTPWrapper) => openClaudeHookService.installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/codex-hook.sh',
          install: (sftp: SFTPWrapper) => new CodexHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/gemini-hook.sh',
          install: (sftp: SFTPWrapper) => new GeminiHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/antigravity-hook.sh',
          install: (sftp: SFTPWrapper) =>
            new AntigravityHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.config/amp/plugins/orca-agent-status.ts',
          install: (sftp: SFTPWrapper) => new AmpHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/cursor-hook.sh',
          install: (sftp: SFTPWrapper) => new CursorHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/command-code-hook.sh',
          install: (sftp: SFTPWrapper) =>
            new CommandCodeHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/grok-hook.sh',
          install: (sftp: SFTPWrapper) => new GrokHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/copilot-hook.sh',
          install: (sftp: SFTPWrapper) => new CopilotHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/devin-hook.sh',
          install: (sftp: SFTPWrapper) => new DevinHookService().installRemote(sftp, '/home/dev')
        },
        {
          path: '/home/dev/.orca/agent-hooks/droid-hook.sh',
          install: (sftp: SFTPWrapper) => new DroidHookService().installRemote(sftp, '/home/dev')
        }
      ]

      for (const { install, path } of installers) {
        const { sftp, fs } = createFakeSftp()
        const status = await install(sftp)
        expect(status.state).toBe('installed')
        const script = fs.files.get(path)
        if (path.includes('/.config/amp/plugins/')) {
          expect(script).toContain('/hook/amp')
          expect(script).toContain("amp.on('agent.start'")
        } else {
          expect(script).toMatch(/^#!\/bin\/sh\n/)
        }
        expect(script).not.toContain('@echo off')
        expect(script).not.toContain('powershell -NoProfile')
      }
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('installs remote Codex hooks with matching trust entries', async () => {
    const { sftp, fs } = createFakeSftp({
      '/home/dev/.codex/hooks.json': `${JSON.stringify({
        hooks: {},
        _managed: {
          'external-manager': {
            Stop: [0]
          }
        }
      })}\n`
    })

    const status = await new CodexHookService().installRemote(sftp, '/home/dev/')

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe('/home/dev/.codex/hooks.json')
    const hooks = JSON.parse(fs.files.get('/home/dev/.codex/hooks.json')!) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
      _managed?: unknown
    }
    expect(hooks._managed).toEqual({ 'external-manager': { Stop: [0] } })
    for (const eventName of [
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PermissionRequest',
      'PostToolUse',
      'Stop'
    ]) {
      const command = hooks.hooks[eventName]?.[0]?.hooks?.[0]?.command
      expect(command).toContain('/home/dev/.orca/agent-hooks/codex-hook.sh')
      expect(command).toMatch(/^if \[ -x /)
    }
    expect(fs.files.get('/home/dev/.orca/agent-hooks/codex-hook.sh')).toContain('#!/bin/sh')
    expect(fs.modes.get('/home/dev/.orca/agent-hooks/codex-hook.sh')).toBe(0o755)
    const toml = fs.files.get('/home/dev/.codex/config.toml')
    expect(toml).toContain('/home/dev/.codex/hooks.json:permission_request:0:0')
    expect(toml).toContain('trusted_hash = "sha256:')
  })

  it('installs Codex hooks into an explicit redirected CODEX_HOME (WSL managed runtime home)', async () => {
    const runtimeHome = '/home/dev/.local/share/orca/codex-runtime-home/home'
    const { sftp, fs } = createFakeSftp({
      [`${runtimeHome}/config.toml`]: 'model = "gpt-5.2-codex"\n'
    })

    const status = await new CodexHookService().installRemote(sftp, '/home/dev', {
      codexHomeDir: runtimeHome,
      deferTrustUntilConfigToml: true
    })

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe(`${runtimeHome}/hooks.json`)
    expect(fs.files.has('/home/dev/.codex/hooks.json')).toBe(false)
    const hooks = JSON.parse(fs.files.get(`${runtimeHome}/hooks.json`)!) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    expect(hooks.hooks.Stop?.[0]?.hooks?.[0]?.command).toContain(
      '/home/dev/.orca/agent-hooks/codex-hook.sh'
    )
    const toml = fs.files.get(`${runtimeHome}/config.toml`)
    expect(toml).toContain('model = "gpt-5.2-codex"')
    expect(toml).toContain(`${runtimeHome}/hooks.json:stop:0:0`)
  })

  it('defers Codex trust writes until the redirected config.toml exists (launch-path seed race)', async () => {
    const runtimeHome = '/home/dev/.local/share/orca/codex-runtime-home/home'
    const { sftp, fs } = createFakeSftp()

    const status = await new CodexHookService().installRemote(sftp, '/home/dev', {
      codexHomeDir: runtimeHome,
      deferTrustUntilConfigToml: true
    })

    expect(status.state).toBe('installed')
    expect(status.detail).toContain('deferred')
    expect(fs.files.get(`${runtimeHome}/hooks.json`)).toContain('codex-hook.sh')
    // Why: creating config.toml here would make the launch path's
    // only-if-absent seed skip the user's real config.
    expect(fs.files.has(`${runtimeHome}/config.toml`)).toBe(false)
  })

  it('reports Codex trust-write failures without rolling back installed hooks', async () => {
    const { sftp, fs } = createFakeSftp()
    fs.failRenameTo.add('/home/dev/.codex/config.toml')

    const status = await new CodexHookService().installRemote(sftp, '/home/dev')

    expect(status.state).toBe('error')
    expect(status.managedHooksPresent).toBe(true)
    expect(status.detail).toContain('trust entries could not be written')
    expect(fs.files.get('/home/dev/.codex/hooks.json')).toContain('codex-hook.sh')
    expect(fs.files.get('/home/dev/.orca/agent-hooks/codex-hook.sh')).toContain('#!/bin/sh')
  })

  it('installs remote Gemini, Antigravity, Cursor, Command Code, Grok, and Devin configs using their CLI-specific schemas', async () => {
    const gemini = createFakeSftp()
    const antigravity = createFakeSftp()
    const amp = createFakeSftp()
    const cursor = createFakeSftp()
    const commandCode = createFakeSftp()
    const grok = createFakeSftp()
    const devin = createFakeSftp({
      '/home/dev/.config/devin/config.json': `{
  // Existing Devin config comment
  "hooks": {},
  "permissions": { "mode": "normal" }
}
`
    })

    await new GeminiHookService().installRemote(gemini.sftp, '/home/dev')
    await new AntigravityHookService().installRemote(antigravity.sftp, '/home/dev')
    await new AmpHookService().installRemote(amp.sftp, '/home/dev')
    await new CursorHookService().installRemote(cursor.sftp, '/home/dev')
    await new CommandCodeHookService().installRemote(commandCode.sftp, '/home/dev')
    await new GrokHookService().installRemote(grok.sftp, '/home/dev')
    await new DevinHookService().installRemote(devin.sftp, '/home/dev')

    const geminiConfig = JSON.parse(gemini.fs.files.get('/home/dev/.gemini/settings.json')!) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    for (const eventName of ['BeforeAgent', 'AfterAgent', 'AfterTool', 'BeforeTool']) {
      const command = geminiConfig.hooks[eventName]?.[0]?.hooks?.[0]?.command
      expect(command).toContain('/home/dev/.orca/agent-hooks/gemini-hook.sh')
      expect(command).toMatch(/^if \[ -x /)
    }
    expect(geminiConfig.hooks.PreToolUse).toBeUndefined()

    const antigravityConfig = JSON.parse(
      antigravity.fs.files.get('/home/dev/.gemini/config/hooks.json')!
    ) as {
      'orca-status': Record<
        string,
        { matcher?: string; command?: string; hooks?: { command: string }[] }[]
      >
    }
    for (const eventName of ['PreInvocation', 'PostInvocation', 'Stop']) {
      const command = antigravityConfig['orca-status'][eventName]?.[0]?.command
      expect(command).toContain('/home/dev/.orca/agent-hooks/antigravity-hook.sh')
      expect(command).toContain(`ORCA_ANTIGRAVITY_EVENT='${eventName}'`)
    }
    expect(antigravityConfig['orca-status'].PreToolUse).toBeUndefined()
    for (const eventName of ['PostToolUse']) {
      const definition = antigravityConfig['orca-status'][eventName]?.[0]
      const command = definition?.hooks?.[0]?.command
      expect(definition?.matcher).toBe('*')
      expect(command).toContain('/home/dev/.orca/agent-hooks/antigravity-hook.sh')
      expect(command).toContain(`ORCA_ANTIGRAVITY_EVENT='${eventName}'`)
    }

    const ampPlugin = amp.fs.files.get('/home/dev/.config/amp/plugins/orca-agent-status.ts')
    expect(ampPlugin).toContain('/hook/amp')
    expect(ampPlugin).toContain("amp.on('tool.call'")
    expect(ampPlugin).toContain('return { action: "allow" }')

    const cursorConfig = JSON.parse(cursor.fs.files.get('/home/dev/.cursor/hooks.json')!) as {
      version: number
      hooks: Record<string, { command?: string; hooks?: unknown[] }[]>
    }
    expect(cursorConfig.version).toBe(1)
    for (const eventName of [
      'beforeSubmitPrompt',
      'stop',
      'preToolUse',
      'postToolUse',
      'postToolUseFailure',
      'beforeShellExecution',
      'beforeMCPExecution',
      'afterAgentResponse'
    ]) {
      const definition = cursorConfig.hooks[eventName]?.[0]
      expect(definition?.command).toContain('/home/dev/.orca/agent-hooks/cursor-hook.sh')
      expect(definition?.hooks).toBeUndefined()
    }

    const commandCodeConfig = JSON.parse(
      commandCode.fs.files.get('/home/dev/.commandcode/settings.json')!
    ) as {
      hooks: Record<string, { matcher?: string; hooks?: { command: string }[] }[]>
    }
    for (const eventName of ['PreToolUse', 'PostToolUse', 'Stop']) {
      const definition = commandCodeConfig.hooks[eventName]?.[0]
      const command = definition?.hooks?.[0]?.command
      expect(command).toContain('/home/dev/.orca/agent-hooks/command-code-hook.sh')
      expect(command).toMatch(/^if \[ -x /)
    }
    expect(commandCodeConfig.hooks.PreToolUse?.[0]?.matcher).toBe('.*')
    expect(commandCodeConfig.hooks.PostToolUse?.[0]?.matcher).toBe('.*')
    expect(commandCodeConfig.hooks.Stop?.[0]?.matcher).toBeUndefined()

    const grokConfig = JSON.parse(grok.fs.files.get('/home/dev/.grok/hooks/orca-status.json')!) as {
      hooks: Record<string, { matcher?: string; hooks?: { command: string }[] }[]>
    }
    for (const eventName of [
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'StopFailure',
      'SessionEnd',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'Notification'
    ]) {
      const definition = grokConfig.hooks[eventName]?.[0]
      const command = definition?.hooks?.[0]?.command
      expect(command).toContain('/home/dev/.orca/agent-hooks/grok-hook.sh')
      expect(command).toMatch(/^if \[ -x /)
    }
    // Why: Grok tool matchers are real regexes; bare `*` is invalid match-all.
    expect(grokConfig.hooks.PreToolUse?.[0]?.matcher).toBe('.*')
    expect(grokConfig.hooks.PostToolUse?.[0]?.matcher).toBe('.*')
    expect(grokConfig.hooks.StopFailure?.[0]?.matcher).toBeUndefined()

    const devinConfig = JSON.parse(devin.fs.files.get('/home/dev/.config/devin/config.json')!) as {
      permissions: { mode: string }
      hooks: Record<string, { matcher?: string; hooks?: { command: string }[] }[]>
    }
    expect(devinConfig.permissions.mode).toBe('normal')
    for (const eventName of [
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'PostCompaction',
      'SessionEnd'
    ]) {
      const definition = devinConfig.hooks[eventName]?.[0]
      const command = definition?.hooks?.[0]?.command
      expect(command).toContain('/home/dev/.orca/agent-hooks/devin-hook.sh')
      expect(command).toMatch(/^if \[ -x /)
    }
    for (const eventName of ['PreToolUse', 'PostToolUse', 'PermissionRequest']) {
      const definition = devinConfig.hooks[eventName]?.[0]
      const command = definition?.hooks?.[0]?.command
      expect(definition?.matcher).toBeUndefined()
      expect(command).toContain('/home/dev/.orca/agent-hooks/devin-hook.sh')
      expect(command).toMatch(/^if \[ -x /)
    }
    expect(devin.fs.files.get('/home/dev/.orca/agent-hooks/devin-hook.sh')).toContain('/hook/devin')
  })

  it('installs remote Grok config in the explicit guest GROK_HOME', async () => {
    const { sftp, fs } = createFakeSftp()

    const status = await new GrokHookService().installRemote(
      sftp,
      '/home/dev',
      '/srv/grok profile/'
    )

    expect(status.configPath).toBe('/srv/grok profile/hooks/orca-status.json')
    expect(fs.files.has('/srv/grok profile/hooks/orca-status.json')).toBe(true)
    expect(fs.files.has('/home/dev/.grok/hooks/orca-status.json')).toBe(false)
    const script = fs.files.get('/home/dev/.orca/agent-hooks/grok-hook.sh')!
    expect(script).toContain('${#GROK_HOME}" -le 4096')
    expect(script).toContain('--data-urlencode "grokHome=${grok_home}"')
  })

  it.each(['relative/grok', '/bad\\grok', `/${'x'.repeat(4096)}`])(
    'falls back to login-home Grok config for invalid remote home %s',
    async (remoteGrokHome) => {
      const { sftp, fs } = createFakeSftp()

      const status = await new GrokHookService().installRemote(sftp, '/home/dev', remoteGrokHome)

      expect(status.configPath).toBe('/home/dev/.grok/hooks/orca-status.json')
      expect(fs.files.has('/home/dev/.grok/hooks/orca-status.json')).toBe(true)
    }
  )

  it('installs remote Kimi hooks as a managed config.toml block preserving user config', async () => {
    const userConfig = 'default_model = "kimi-k2.6"\n\n[providers."mine"]\napi_key = "sk-secret"\n'
    const { sftp, fs } = createFakeSftp({ '/home/dev/.kimi-code/config.toml': userConfig })

    const status = await new KimiHookService().installRemote(sftp, '/home/dev')
    expect(status.state).toBe('installed')

    const config = fs.files.get('/home/dev/.kimi-code/config.toml')!
    // User config above the managed block is preserved.
    expect(config).toContain('default_model = "kimi-k2.6"')
    expect(config).toContain('api_key = "sk-secret"')
    for (const eventName of [
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'Stop',
      'StopFailure'
    ]) {
      expect(config).toContain(`event = "${eventName}"`)
    }
    // The command points at the POSIX managed script via the `[ -x ]` guard.
    expect(config).toContain('/home/dev/.orca/agent-hooks/kimi-hook.sh')
    expect(config).toMatch(/command = "if \[ -x /)
    expect(fs.files.get('/home/dev/.orca/agent-hooks/kimi-hook.sh')).toContain('/hook/kimi')
  })

  it('does not overwrite malformed remote Devin JSONC', async () => {
    const original = '{"hooks": }'
    const { sftp, fs } = createFakeSftp({
      '/home/dev/.config/devin/config.json': original
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const status = await new DevinHookService().installRemote(sftp, '/home/dev')

      expect(status).toMatchObject({
        agent: 'devin',
        state: 'error',
        configPath: '/home/dev/.config/devin/config.json',
        managedHooksPresent: false,
        detail: 'Could not parse remote Devin config.json'
      })
      expect(fs.files.get('/home/dev/.config/devin/config.json')).toBe(original)
      expect(fs.files.get('/home/dev/.orca/agent-hooks/devin-hook.sh')).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('removes stale remote Antigravity PreToolUse hooks while installing SSH hooks', async () => {
    const { sftp, fs } = createFakeSftp()
    fs.files.set(
      '/home/dev/.gemini/config/hooks.json',
      `${JSON.stringify(
        {
          'orca-status': {
            PreToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: '/tmp/old/agent-hooks/antigravity-hook.sh'
                  }
                ]
              }
            ],
            PostToolUse: [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: 'echo user-authored'
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    )

    await new AntigravityHookService().installRemote(sftp, '/home/dev')

    const config = JSON.parse(fs.files.get('/home/dev/.gemini/config/hooks.json')!) as {
      'orca-status': Record<string, { hooks?: { command: string }[] }[]>
    }
    expect(config['orca-status'].PreToolUse).toBeUndefined()
    const postToolCommands = config['orca-status'].PostToolUse.flatMap((definition) =>
      (definition.hooks ?? []).map((hook) => hook.command)
    )
    expect(postToolCommands).toContain('echo user-authored')
    expect(postToolCommands.some((command) => command.includes('antigravity-hook.sh'))).toBe(true)
  })

  it('removes stale remote Gemini PreToolUse hooks while preserving user-authored hooks', async () => {
    const { sftp, fs } = createFakeSftp()
    fs.files.set(
      '/home/dev/.gemini/settings.json',
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    type: 'command',
                    command:
                      "if [ -x '/tmp/old/agent-hooks/gemini-hook.sh' ]; then /bin/sh '/tmp/old/agent-hooks/gemini-hook.sh'; fi"
                  }
                ]
              },
              {
                hooks: [
                  {
                    type: 'command',
                    command: 'echo user-authored'
                  }
                ]
              }
            ]
          }
        },
        null,
        2
      )}\n`
    )

    await new GeminiHookService().installRemote(sftp, '/home/dev')

    const config = JSON.parse(fs.files.get('/home/dev/.gemini/settings.json')!) as {
      hooks: Record<string, { hooks?: { command: string }[] }[]>
    }
    const preToolCommands = config.hooks.PreToolUse.flatMap((definition) =>
      (definition.hooks ?? []).map((hook) => hook.command)
    )
    expect(preToolCommands).toEqual(['echo user-authored'])
    const beforeToolCommands = config.hooks.BeforeTool.flatMap((definition) =>
      (definition.hooks ?? []).map((hook) => hook.command)
    )
    expect(beforeToolCommands.some((command) => command.includes('gemini-hook.sh'))).toBe(true)
  })

  it('installs remote Copilot hooks under the user-level hooks directory', async () => {
    const { sftp, fs } = createFakeSftp()
    fs.dirs.add('/home/dev/.copilot')
    fs.dirs.add('/home/dev/.copilot/hooks')
    fs.files.set(
      '/home/dev/.copilot/hooks/orca.json',
      JSON.stringify({
        version: 99,
        disableAllHooks: true,
        hooks: {}
      })
    )

    const status = await new CopilotHookService().installRemote(sftp, '/home/dev/')

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe('/home/dev/.copilot/hooks/orca.json')
    const config = JSON.parse(fs.files.get('/home/dev/.copilot/hooks/orca.json')!) as {
      version: number
      disableAllHooks?: boolean
      hooks: Record<string, { bash?: string; timeoutSec?: number }[]>
    }
    expect(config.version).toBe(1)
    for (const eventName of [
      'SessionStart',
      'SessionEnd',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'subagentStart',
      'SubagentStop',
      'PreCompact',
      'Stop',
      'ErrorOccurred',
      'PermissionRequest',
      'Notification'
    ]) {
      const definition = config.hooks[eventName]?.[0]
      expect(definition?.bash).toContain('/home/dev/.orca/agent-hooks/copilot-hook.sh')
      expect(definition?.bash).toContain(`ORCA_COPILOT_HOOK_EVENT='${eventName}'`)
      expect(definition?.timeoutSec).toBe(5)
    }
    expect(config.disableAllHooks).toBeUndefined()
    expect(fs.files.get('/home/dev/.orca/agent-hooks/copilot-hook.sh')).toContain('#!/bin/sh')
    expect(fs.modes.get('/home/dev/.orca/agent-hooks/copilot-hook.sh')).toBe(0o755)
  })

  // Why: Droid (and Copilot) each shipped a working installRemote but were never
  // registered in REMOTE_MANAGED_HOOK_INSTALLERS, so their status silently never
  // appeared over SSH (issue #7253). Guard the whole bug class, not one agent:
  // every locally-managed hook service that implements installRemote MUST be
  // wired into the remote installer.
  it('registers every managed agent that implements installRemote in the remote installer (issue #7253)', () => {
    const servicesByAgent = new Map<string, { installRemote?: unknown }>([
      ['claude', claudeHookService],
      ['openclaude', openClaudeHookService],
      ['codex', codexHookService],
      ['gemini', geminiHookService],
      ['antigravity', antigravityHookService],
      ['amp', ampHookService],
      ['cursor', cursorHookService],
      ['droid', droidHookService],
      ['command-code', commandCodeHookService],
      ['grok', grokHookService],
      ['copilot', copilotHookService],
      ['hermes', hermesHookService],
      ['devin', devinHookService],
      ['kimi', kimiHookService]
    ])

    // Guard against a service silently missing from the map above as new agents land.
    for (const [agent] of MANAGED_AGENT_HOOK_INSTALLERS) {
      expect(servicesByAgent.has(agent)).toBe(true)
    }

    const registered = new Set<string>(REMOTE_MANAGED_HOOK_INSTALLER_AGENTS)
    const missing: string[] = []
    for (const [agent, service] of servicesByAgent) {
      if (typeof service.installRemote === 'function' && !registered.has(agent)) {
        missing.push(agent)
      }
    }
    expect(missing).toEqual([])
  })

  it('installs Droid and Copilot when running the aggregate remote installer (issue #7253)', async () => {
    const { sftp } = createFakeSftp()
    const results = await installRemoteManagedAgentHooks(sftp, '/home/dev')
    const byAgent = new Map(results.map((r) => [r.agent, r.state]))
    expect(byAgent.get('droid')).toBe('installed')
    expect(byAgent.get('copilot')).toBe('installed')
  })

  it('installs remote Droid hooks into Factory settings.json (issue #7253)', async () => {
    const { sftp, fs } = createFakeSftp()

    const status = await new DroidHookService().installRemote(sftp, '/home/dev')

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe('/home/dev/.factory/settings.json')
    const config = JSON.parse(fs.files.get('/home/dev/.factory/settings.json')!) as {
      hooks: Record<string, { matcher?: string; hooks?: { command: string }[] }[]>
    }
    for (const eventName of [
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'SubagentStop',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'Notification'
    ]) {
      const definition = config.hooks[eventName]?.[0]
      const command = definition?.hooks?.[0]?.command
      expect(command).toContain('/home/dev/.orca/agent-hooks/droid-hook.sh')
      expect(command).toMatch(/^if \[ -x /)
    }
    // Tool/permission events carry a `*` matcher; lifecycle events do not.
    expect(config.hooks.PreToolUse?.[0]?.matcher).toBe('*')
    expect(config.hooks.PostToolUse?.[0]?.matcher).toBe('*')
    expect(config.hooks.PermissionRequest?.[0]?.matcher).toBe('*')
    expect(config.hooks.Stop?.[0]?.matcher).toBeUndefined()
    const script = fs.files.get('/home/dev/.orca/agent-hooks/droid-hook.sh')
    expect(script).toContain('#!/bin/sh')
    expect(script).toContain('/hook/droid')
    expect(fs.modes.get('/home/dev/.orca/agent-hooks/droid-hook.sh')).toBe(0o755)
  })

  it('does not overwrite a malformed remote Factory settings.json', async () => {
    const original = '{"hooks": }'
    const { sftp, fs } = createFakeSftp({
      '/home/dev/.factory/settings.json': original
    })

    const status = await new DroidHookService().installRemote(sftp, '/home/dev')

    expect(status).toMatchObject({
      agent: 'droid',
      state: 'error',
      configPath: '/home/dev/.factory/settings.json',
      managedHooksPresent: false,
      detail: 'Could not parse remote Factory settings.json'
    })
    expect(fs.files.get('/home/dev/.factory/settings.json')).toBe(original)
    expect(fs.files.get('/home/dev/.orca/agent-hooks/droid-hook.sh')).toBeUndefined()
  })

  it('installs remote Hermes plugin files and enables the plugin', async () => {
    const { sftp, fs } = createFakeSftp()

    const status = await new HermesHookService().installRemote(sftp, '/home/dev')

    expect(status.state).toBe('installed')
    expect(status.configPath).toBe('/home/dev/.hermes/config.yaml')
    expect(fs.files.get('/home/dev/.hermes/plugins/orca-status/plugin.yaml')).toContain(
      'pre_llm_call'
    )
    expect(fs.files.get('/home/dev/.hermes/plugins/orca-status/__init__.py')).toContain(
      '/hook/hermes'
    )
    expect(fs.files.get('/home/dev/.hermes/config.yaml')).toContain('orca-status')
  })

  it('does not overwrite a remote user-authored Amp plugin file', async () => {
    const { sftp, fs } = createFakeSftp({
      '/home/dev/.config/amp/plugins/orca-agent-status.ts':
        'export default function userPlugin() {}\n'
    })

    const status = await new AmpHookService().installRemote(sftp, '/home/dev/')

    expect(status).toMatchObject({
      agent: 'amp',
      state: 'partial',
      managedHooksPresent: false
    })
    expect(fs.files.get('/home/dev/.config/amp/plugins/orca-agent-status.ts')).toBe(
      'export default function userPlugin() {}\n'
    )
  })
})
