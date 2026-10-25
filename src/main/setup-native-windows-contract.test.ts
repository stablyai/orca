import { spawnShellWithFallback } from './providers/local-pty-utils'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import { runProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { resolveWindowsShellLaunchArgs } from './providers/windows-shell-args'
import { buildWindowsPowerShellSpawnAttempts } from './providers/windows-shell-fallback-chain'
import { buildSetupRunnerCommand } from '../shared/setup-runner-command'
import {
  appendNativeSetupCompletion,
  createSetupCompletionScanner,
  nativeSetupCompletionShell,
  stripNativeSetupCompletionEnvironment
} from './runtime/orchestration/setup-completion-signal'

it.skipIf(process.platform !== 'win32')(
  'executes native cmd and PowerShell argv/stdin and fallback setup with exact status, guarded path and live parent',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-31255-native-'))
    const system = process.env.SystemRoot ?? 'C:\\Windows'
    const cmd = join(system, 'System32', 'cmd.exe')
    const powershell = join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const killtree = process.env.ORCA_QA_KILLTREE
    expect(
      killtree && isAbsolute(killtree) && existsSync(killtree),
      'root must supply absolute admitted qa-killtree.ps1'
    ).toBeTruthy()
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_CACHE_HOME: join(root, 'cache'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      ORCA_E2E_USER_DATA_DIR: join(root, 'orca'),
      ORCA_E2E_HOME_DIR: root,
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
      ORCA_SETUP_COMPLETION_TOKEN: 'native:windows-contract'
    }
    stripNativeSetupCompletionEnvironment(env)
    const { spawn } = await import('node-pty')
    try {
      const guarded = join(root, 'space & percent% bang!')
      await mkdir(guarded)
      for (const status of [0, 17]) {
        const path = join(guarded, 'setup.cmd')
        await writeFile(
          path,
          `@echo off\r\necho body:%cd%:token=%ORCA_SETUP_COMPLETION_TOKEN%\r\nexit /b ${status}\r\n`
        )
        await writeFile(join(root, 'plain.cmd'), `@exit /b ${status}\r\n`)
        const commands = [
          buildSetupRunnerCommand(path, 'windows'),
          'cmd.exe /c plain.cmd',
          `cmd.exe /c plain.cmd${' '.repeat(6100)}`
        ]
        for (const route of [cmd, powershell, 'fallback', 'cmd-argv-control']) {
          const control = route === 'cmd-argv-control'
          const shell = route === 'fallback' || control ? cmd : route
          for (const command of control ? commands.slice(1, 2) : commands) {
            const label = `${status}/${route}/${commands.indexOf(command)}`
            const token = control
              ? undefined
              : `native:windows-${status}-${shell === cmd ? 'cmd' : 'ps'}`
            const resolved = resolveWindowsShellLaunchArgs(
              shell,
              root,
              root,
              undefined,
              command,
              undefined,
              token
            )
            // No personal profile is opened by this isolated process fixture.
            const args =
              shell === powershell
                ? ['-NoProfile', ...resolved.shellArgs]
                : ['/d', ...resolved.shellArgs]
            const spawned =
              route === 'fallback'
                ? spawnShellWithFallback({
                    shellPath: join(root, 'absent-pwsh.exe'),
                    shellArgs: [],
                    cols: 200,
                    rows: 40,
                    cwd: root,
                    env,
                    ptySpawn: spawn,
                    windowsFallbackAttempts: [
                      {
                        shellPath: join(root, 'absent-pwsh.exe'),
                        shellArgs: [],
                        effectiveCwd: root,
                        validationCwd: root,
                        startupCommandDeliveredInShellArgs: false
                      },
                      {
                        shellPath: shell,
                        shellArgs: args,
                        effectiveCwd: root,
                        validationCwd: root,
                        startupCommandDeliveredInShellArgs:
                          resolved.startupCommandDeliveredInShellArgs === true
                      }
                    ]
                  })
                : {
                    process: spawn(shell, args, {
                      cwd: resolved.effectiveCwd,
                      env,
                      cols: status === 0 && route === cmd && command === commands[1] ? 32 : 200,
                      rows: 40
                    }),
                    shellPath: shell,
                    startupCommandDeliveredInShellArgs:
                      resolved.startupCommandDeliveredInShellArgs === true
                  }
            const proc = spawned.process
            const winningShell = spawned.shellPath
            const delivered = spawned.startupCommandDeliveredInShellArgs === true
            console.info('native setup schedule', {
              label,
              command,
              args,
              delivered,
              winningShell,
              pid: proc.pid
            })
            const startedPromise = runProcess({
              program: powershell,
              args: [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-Process -Id ${proc.pid}).StartTime.ToUniversalTime().ToString('o')`
              ],
              env
            })
            let exited = false
            let output = ''
            let sent = delivered
            let checked = false
            let code: number | undefined
            let parentCode: number | undefined
            const scanner = token
              ? createSetupCompletionScanner(token, (value) => {
                  code = value
                })
              : undefined
            const completion = new Promise<void>((resolve, reject) => {
              proc.onExit(() => {
                exited = true
                resolve()
              })
              proc.onData((data) => {
                output += data
                scanner?.scan(data)
                if (!sent && (output.includes('>') || output.includes(']133;B'))) {
                  sent = true
                  const native = appendNativeSetupCompletion(
                    command,
                    token,
                    nativeSetupCompletionShell(winningShell)
                  )
                  expect(native.startsWith(command)).toBe(true)
                  proc.write(`${native}\r`)
                }
                if (control && !checked && output.includes(`${root}>`)) {
                  checked = true
                  proc.write('echo __ORCA_PARENT_STATUS__:%errorlevel%& echo parent-alive\r')
                }
                if (winningShell === cmd) {
                  const match = output.match(/(?:^|\r?\n)__ORCA_PARENT_STATUS__:(-?\d+)\r?\n/)
                  if (match) {
                    parentCode = Number(match[1])
                    if (control) {
                      code = parentCode
                    }
                  }
                }
                if (code !== undefined && !checked) {
                  checked = true
                  proc.write(
                    winningShell === cmd
                      ? 'echo __ORCA_PARENT_STATUS__:%errorlevel%& echo parent-alive\r'
                      : "[Console]::WriteLine(); [Console]::WriteLine('parent-alive')\r"
                  )
                }
                if (
                  checked &&
                  (winningShell === cmd
                    ? parentCode !== undefined
                    : /(?:^|\r?\n)parent-alive\r?\n/.test(output))
                ) {
                  proc.write('exit\r')
                }
              })
              setTimeout(
                () => reject(new Error(`native shell completion timeout (${label}): ${output}`)),
                20_000
              ).unref()
            })
            const started = await startedPromise
            const startedAt = started.stdout.trim()
            try {
              await completion
              expect(winningShell, label).toBe(shell)
              expect(delivered, label).toBe(resolved.startupCommandDeliveredInShellArgs === true)
              if (shell === cmd) {
                expect(delivered, label).toBe(control)
                expect(parentCode, output).toBe(status)
              }
              expect(code, output).toBe(status)
              expect(output).toContain('parent-alive')
              if (command === commands[0]) {
                expect(output).toContain(`body:${root}:token=`)
                expect(output).not.toContain('token=native:')
              }
              console.info('native setup schedule passed', { label, code, delivered, winningShell })
            } finally {
              if (!exited) {
                expect(startedAt).not.toBe('')
                await runProcess({
                  program: powershell,
                  args: [
                    '-NoProfile',
                    '-File',
                    killtree!,
                    '-RootPid',
                    String(proc.pid),
                    '-RootStarted',
                    startedAt,
                    '-Image',
                    winningShell
                  ],
                  env
                })
              }
            }
          }
        }
      }
      const attempts = buildWindowsPowerShellSpawnAttempts({
        shellPath: powershell,
        cwd: root,
        defaultCwd: root,
        startupCommand: 'cmd.exe /c plain.cmd',
        nativeSetupToken: 'native:fallback',
        resolveOptions: { platform: 'win32', env, isRealExecutable: (p) => p === powershell }
      })
      expect(attempts.map((a) => nativeSetupCompletionShell(a.shellPath))).toEqual([
        'powershell',
        'cmd'
      ])
      expect(Buffer.from(attempts[0].shellArgs.at(-1)!, 'base64').toString('utf16le')).toContain(
        'native:fallback'
      )
      expect(attempts[1].startupCommandDeliveredInShellArgs).toBe(false)
      expect(attempts[1].shellArgs.join(' ')).not.toContain('native:fallback')
      expect(
        appendNativeSetupCompletion(
          'cmd.exe /c plain.cmd',
          'native:fallback',
          nativeSetupCompletionShell(attempts[1].shellPath)
        )
      ).toBe(
        'cmd.exe /c plain.cmd & call "%ComSpec%" /d /c ^"echo ORCA_SETUP_DONE:native:fallback:%^errorlevel%;^&exit /b %^errorlevel%^"'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  120_000
)
