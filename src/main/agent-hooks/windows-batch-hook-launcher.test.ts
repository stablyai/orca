import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { getWindowsManagedLifecycleHook } from '../claude/hook-settings'
import { wrapWindowsCmdHookCommand, wrapWindowsHookCommand } from './installer-utils'
import { findGitBash } from './windows-git-bash-path.test-fixture'
import {
  getWindowsPowerShellExecutablePath,
  wrapWindowsPowerShellEncodedCommand
} from './windows-powershell-hook-launcher'

function decodeCommand(command: string): string {
  const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  if (!encoded) {
    throw new Error('Missing encoded launcher')
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('batch hook policy setup', () => {
  it.each(['.cmd', '.CMD', '.ps1', '.PS1', '.cmd.ps1'])(
    'preserves policy setup for scripts that require it: %s',
    (extension) => {
      const path = `C:\\Users\\测试用户\\.orca\\agent-hooks\\hook${extension}`
      const commands = [
        wrapWindowsCmdHookCommand(path),
        getWindowsManagedLifecycleHook(path).command
      ]
      for (const command of commands) {
        expect(decodeCommand(command).includes('Set-ExecutionPolicy')).toBe(
          extension.toLowerCase() !== '.cmd'
        )
        expect(decodeCommand(command)).toContain('Test-Path -LiteralPath')
      }
      expect(decodeCommand(wrapWindowsHookCommand(path))).toContain('Set-ExecutionPolicy')
    }
  )
})

describe.skipIf(process.platform !== 'win32')('guarded Windows batch hook commands', () => {
  const pwsh = (process.env.PATH ?? '')
    .split(delimiter)
    .map((directory) => join(directory, 'pwsh.exe'))
    .find((file) => existsSync(file))
  const shells = [
    {
      name: 'cmd',
      program: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
      args: ['/d', '/v:off', '/c']
    },
    {
      name: 'PowerShell 5.1',
      program: getWindowsPowerShellExecutablePath(),
      args: ['-NoProfile', '-Command']
    },
    ...(pwsh ? [{ name: 'PowerShell 7', program: pwsh, args: ['-NoProfile', '-Command'] }] : []),
    { name: 'Git Bash', program: process.platform === 'win32' ? findGitBash() : '', args: ['-c'] }
  ]

  it.each(['测试用户', 'rene\u0301', "测试 用户 O'Brien"])(
    'keeps present and deleted %s entries compatible with every host',
    async (profile) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-batch-launcher-'))
      const home = join(root, profile)
      const scriptPath = join(home, '.orca', 'agent-hooks', 'claude-hook.cmd')
      mkdirSync(join(home, '.orca', 'agent-hooks'), { recursive: true })
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
        ),
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_AGENT_HOOK_PORT: '1',
        ORCA_AGENT_HOOK_TOKEN: 'batch-launcher-test',
        ORCA_PANE_KEY: 'tab:leaf',
        PSExecutionPolicyPreference: 'Restricted'
      }
      const input = JSON.stringify({ prompt: '한국어 日本語 😀 & %PATH% !'.repeat(4096) })
      const entries = [
        { command: wrapWindowsCmdHookCommand(scriptPath), missingStdout: '' },
        { command: getWindowsManagedLifecycleHook(scriptPath).command, missingStdout: '{}' }
      ]
      try {
        for (const entry of entries) {
          const entryEnv = {
            ...env,
            USERPROFILE: entry.missingStdout ? home : process.env.USERPROFILE
          }
          const invoke = (program: string, args: string[]) =>
            runProcess({
              program,
              args,
              env: entryEnv,
              input,
              timeoutMs: 10_000,
              terminationBarrier: true
            })
          const [program, ...args] = entry.command.split(' ')
          const hosts = [
            ...shells.map((shell) => ({ ...shell, args: [...shell.args, entry.command] })),
            { name: 'direct argv', program, args }
          ]
          writeFileSync(
            scriptPath,
            '@echo off\r\necho {}\r\n"%SystemRoot%\\System32\\more.com" >nul 2>nul\r\nexit /b 0\r\n'
          )
          for (const host of hosts) {
            const result = await invoke(host.program, host.args)
            if (entry.missingStdout) {
              // A synthetic USERPROFILE can break the host's cmd AutoRun; compare the released launcher.
              const body = decodeCommand(entry.command)
              const legacy = wrapWindowsPowerShellEncodedCommand(
                body.slice(body.indexOf('$scriptPath ='))
              )
              const legacyHost =
                host.name === 'direct argv'
                  ? { program: legacy.split(' ')[0], args: legacy.split(' ').slice(1) }
                  : { program: host.program, args: [...host.args.slice(0, -1), legacy] }
              const before = await invoke(legacyHost.program, legacyHost.args)
              expect(result, host.name).toMatchObject({
                code: before.code,
                stdout: before.stdout,
                stderr: before.stderr,
                timedOut: false
              })
              if (before.code === 0) {
                expect(result.stdout.trim(), host.name).toBe('{}')
              }
            } else {
              expect(result, host.name).toMatchObject({ code: 0, stderr: '', timedOut: false })
              expect(result.stdout.trim(), host.name).toBe('{}')
            }
          }
          rmSync(scriptPath)
          for (const host of hosts) {
            const result = await invoke(host.program, host.args)
            expect(result, host.name).toMatchObject({ code: 0, stderr: '', timedOut: false })
            expect(result.stdout.trim(), host.name).toBe(entry.missingStdout)
          }
        }
      } finally {
        await removeTree(root)
      }
    },
    60_000
  )

  it('still runs a PowerShell hook under an AllSigned process policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-ps1-policy-'))
    const scriptPath = join(root, '测试-hook.ps1')
    try {
      writeFileSync(scriptPath, "Write-Output '{}'; exit 0")
      const command = wrapWindowsCmdHookCommand(scriptPath)
      const [program, ...args] = command.split(' ')
      const result = await runProcess({
        program,
        args,
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          PSExecutionPolicyPreference: 'AllSigned'
        },
        input: '{}',
        timeoutMs: 10_000,
        terminationBarrier: true
      })
      expect(result).toMatchObject({ code: 0, timedOut: false })
      expect(result.stdout.trim()).toBe('{}')
    } finally {
      await removeTree(root)
    }
  })

  it('preserves the process policy inherited by a batch hook and its PowerShell child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-policy-测试-'))
    const scriptPath = join(root, 'hook.cmd')
    try {
      writeFileSync(join(root, 'child.ps1'), "Write-Output '{}'; exit 0")
      writeFileSync(
        scriptPath,
        `@echo off\r\n"${getWindowsPowerShellExecutablePath()}" -NoProfile -File "%~dp0child.ps1"\r\nexit /b %ERRORLEVEL%\r\n`
      )
      const [program, ...args] = wrapWindowsCmdHookCommand(scriptPath).split(' ')
      const result = await runProcess({
        program,
        args,
        env: {
          ...process.env,
          ORCA_BACKGROUND_LAUNCH: '1',
          PSExecutionPolicyPreference: 'Restricted'
        },
        input: '{}',
        timeoutMs: 10000,
        terminationBarrier: true
      })
      expect(result).toMatchObject({ code: 0, stdout: '{}\r\n', stderr: '', timedOut: false })
    } finally {
      await removeTree(root)
    }
  })
})
