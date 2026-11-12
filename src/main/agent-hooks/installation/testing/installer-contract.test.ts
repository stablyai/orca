import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { wrapPosixHookCommand } from '../commands/posix-hook-command'
import { wrapWindowsHookCommand } from '../commands/windows-hook-command'
import { writeHooksJson } from '../configuration/hooks-json-write'
import type { HooksConfig } from '../configuration/hook-config-schema'
import '../scripts/hook-post-command'
import { wrapRuntimeHomeHookCommand } from '../commands/runtime-home-hook-command'
import { wrapWindowsCmdShellHookCommand } from '../../windows-cmd-shell-hook-command'

let tmpDir: string
let configPath: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'orca-installer-utils-test-'))
  configPath = join(tmpDir, 'settings.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('writeHooksJson', () => {
  const stopHookConfig = (command: string): HooksConfig => ({
    hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] }
  })

  it('updates a symlink target without replacing the hook config link', () => {
    const targetPath = join(tmpDir, 'dotfiles-hooks.json')
    writeFileSync(targetPath, '{"hooks":{}}\n')
    symlinkSync(targetPath, configPath)

    writeHooksJson(configPath, { hooks: { Stop: [] } })

    expect(lstatSync(configPath).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(targetPath, 'utf-8'))).toEqual({
      hooks: { Stop: [] }
    })
  })

  it.skipIf(process.platform === 'win32')(
    'keeps an owner-only config owner-only when it rewrites it',
    () => {
      writeFileSync(configPath, '{"hooks":{}}\n')
      chmodSync(configPath, 0o600)

      writeHooksJson(configPath, { hooks: { Stop: [] } })

      expect(statSync(configPath).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(configPath, 'utf-8'))).toEqual({ hooks: { Stop: [] } })
    }
  )

  it('does not follow an existing .bak symlink', () => {
    const original = '{"hooks":{}}\n'
    const backupTarget = join(tmpDir, 'dotfiles-backup.json')
    writeFileSync(configPath, original, 'utf-8')
    writeFileSync(backupTarget, 'pristine backup target\n', 'utf-8')
    symlinkSync(backupTarget, `${configPath}.bak`)

    expect(() => writeHooksJson(configPath, { hooks: { Stop: [] } })).toThrow(
      'Refusing to overwrite symlinked backup'
    )

    expect(readFileSync(configPath, 'utf-8')).toBe(original)
    expect(lstatSync(`${configPath}.bak`).isSymbolicLink()).toBe(true)
    expect(readFileSync(backupTarget, 'utf-8')).toBe('pristine backup target\n')
  })

  it('is a no-op (does not rotate .bak) when the serialized content is unchanged', () => {
    const config = stopHookConfig('foo')
    writeHooksJson(configPath, config)
    // First write had no prior file, so no .bak should exist.
    expect(existsSync(`${configPath}.bak`)).toBe(false)

    // Writing identical content must not create or rotate the .bak file.
    writeHooksJson(configPath, config)
    expect(existsSync(`${configPath}.bak`)).toBe(false)

    // A second distinct write must still produce a .bak from the prior content,
    // proving the no-op only triggers on byte-identical content.
    const updated = stopHookConfig('bar')
    writeHooksJson(configPath, updated)
    const bak = JSON.parse(readFileSync(`${configPath}.bak`, 'utf-8'))
    expect(bak).toEqual(config)
  })
})

describe('wrapPosixHookCommand', () => {
  it.skipIf(process.platform === 'win32')(
    'executes a script whose path contains a single quote literally',
    () => {
      const scriptPath = join(tmpDir, "with'quote", 'hook.sh')
      mkdirSync(join(tmpDir, "with'quote"))
      writeFileSync(scriptPath, "#!/bin/sh\nprintf 'quoted-path\n'\n", { mode: 0o755 })
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', wrapPosixHookCommand(scriptPath)],
        timeoutMs: 5000
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('quoted-path\n')
      expect(result.stderr).toBe('')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'passes a literal environment value only to the guarded script',
    () => {
      const scriptPath = join(tmpDir, 'env-hook.sh')
      const event = "UserPromptSubmit ' $HOME ;"
      writeFileSync(scriptPath, '#!/bin/sh\nprintf "%s" "$ORCA_COPILOT_HOOK_EVENT"\n', {
        mode: 0o755
      })
      const command = wrapPosixHookCommand(scriptPath, { ORCA_COPILOT_HOOK_EVENT: event })
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', `${command}; printf '\n%s' "$ORCA_COPILOT_HOOK_EVENT"`],
        env: { ...process.env, ORCA_COPILOT_HOOK_EVENT: 'parent-value' },
        timeoutMs: 5000
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe(`${event}\nparent-value`)
      expect(result.stderr).toBe('')
    }
  )

  it.skipIf(process.platform === 'win32')(
    'writes the fallback response and still drains a large stdin payload',
    () => {
      const cmd = wrapPosixHookCommand('/does/not/exist.sh', {}, { fallbackStdout: '{"a":"b"}' })
      const result = runProcessSync({
        program: '/bin/sh',
        args: ['-c', cmd],
        input: 'x'.repeat(1_000_000),
        timeoutMs: 5000
      })
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('{"a":"b"}\n')
    }
  )

  // 4d618795 replaced && … || true to preserve failing script exit codes; guard against swallowing them again.
  it.skipIf(process.platform === 'win32')(
    'propagates the script exit code when the script runs and fails',
    () => {
      const scriptPath = join(tmpDir, 'fails.sh')
      writeFileSync(scriptPath, '#!/bin/sh\nexit 7\n', 'utf-8')
      chmodSync(scriptPath, 0o755)
      const cmd = wrapPosixHookCommand(scriptPath)
      const result = runProcessSync({ program: '/bin/sh', args: ['-c', cmd], timeoutMs: 5000 })
      expect(result.code).toBe(7)
    }
  )
})

describe('wrapWindowsHookCommand', () => {
  // Gate events read silence as denial, so answer before a missing-context guard can exit.

  it.skipIf(process.platform !== 'win32')(
    'executes a script path containing a cmd.exe caret literally',
    () => {
      const scriptDir = join(tmpDir, 'home with ^ caret', '.orca', 'agent-hooks')
      mkdirSync(scriptDir, { recursive: true })
      const scriptPath = join(scriptDir, 'codex-hook.cmd')
      writeFileSync(scriptPath, '@echo off\r\nexit /b 7\r\n', 'utf-8')

      const result = runProcessSync({
        program: 'cmd.exe',
        args: ['/d', '/c', wrapWindowsHookCommand(scriptPath)],
        env: { ...process.env, ORCA_WRAP_TEST: 'expanded' },
        timeoutMs: 5000
      })

      expect(result.code).toBe(7)
    }
  )
})

describe('wrapWindowsCmdShellHookCommand', () => {
  it('quotes a safe path and drains stdin when the script is missing', () => {
    const scriptPath = 'C:\\Users\\alice\\.orca\\agent-hooks\\junie-hook.cmd'
    const command = wrapWindowsCmdShellHookCommand(scriptPath)
    expect(command).toBe(
      `if exist "${scriptPath}" (call "${scriptPath}") else ("%SystemRoot%\\System32\\more.com" >nul 2>nul)`
    )
  })

  it('falls back to the encoded launcher when the path contains percent signs', () => {
    const scriptPath = 'C:\\Users\\%ORCA_TEST%\\agent-hooks\\junie-hook.cmd'
    const command = wrapWindowsCmdShellHookCommand(scriptPath)
    expect(command).toMatch(qualifiedWindowsPowerShellCommand)
    expect(decodeWindowsHookCommand(command)).toBe(expectedDecodedWindowsHookCommand(scriptPath))
  })
})

describe('wrapRuntimeHomeHookCommand', () => {
  const shell =
    process.platform === 'win32'
      ? join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe')
      : '/bin/sh'

  // Grok rejects unresolved bare variables even in untaken branches.

  it('executes the destination HOME script for the current runtime', () => {
    const sourceHome = join(tmpDir, 'source profile')
    const destinationHome = join(tmpDir, "destination $HOME ' & profile")
    const sourceScriptDir = join(sourceHome, '.orca', 'agent-hooks')
    const destinationScriptDir = join(destinationHome, '.orca', 'agent-hooks')
    mkdirSync(sourceScriptDir, { recursive: true })
    mkdirSync(destinationScriptDir, { recursive: true })
    const windowsExitCode = process.platform === 'win32' ? 7 : 9
    const posixExitCode = process.platform === 'win32' ? 9 : 7
    writeFileSync(
      join(destinationScriptDir, 'claude-hook.cmd'),
      `@echo off\r\nexit /b ${windowsExitCode}\r\n`,
      'utf-8'
    )
    writeFileSync(
      join(destinationScriptDir, 'claude-hook.sh'),
      `#!/bin/sh\nexit ${posixExitCode}\n`,
      'utf-8'
    )
    writeFileSync(join(sourceScriptDir, 'claude-hook.cmd'), '@echo off\r\nexit /b 9\r\n', 'utf-8')
    writeFileSync(join(sourceScriptDir, 'claude-hook.sh'), '#!/bin/sh\nexit 9\n', 'utf-8')
    chmodSync(join(destinationScriptDir, 'claude-hook.sh'), 0o755)

    const result = runProcessSync({
      program: shell,
      args: ['-c', wrapRuntimeHomeHookCommand('claude-hook')],
      env: {
        ...process.env,
        HOME: destinationHome.replaceAll('\\', '/'),
        USERPROFILE: destinationHome
      },
      timeoutMs: 5000
    })

    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr.toString()).toBe(7)
  })

  it('emits neutral JSON when a lifecycle script is missing', () => {
    const result = runProcessSync({
      program: shell,
      args: [
        '-c',
        wrapRuntimeHomeHookCommand('missing-orca-hook', { neutralJsonWhenMissing: true })
      ],
      env: { ...process.env, HOME: tmpDir.replaceAll('\\', '/') },
      input: 'x'.repeat(1_000_000),
      timeoutMs: 5000
    })

    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr.toString()).toBe(0)
    expect(JSON.parse(result.stdout.toString().trim())).toEqual({})
  })
})
