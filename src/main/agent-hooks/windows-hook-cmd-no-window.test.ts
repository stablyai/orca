import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wrapWindowsHookCommand } from './installer-utils'
import { getWindowsPowerShellExecutablePath } from './windows-powershell-hook-launcher'

const GROK_MIN_HOOK_STDIN = '{"hook_event_name":"PreToolUse"}\n'
const titledWindowSamplerCommand =
  '$seen = New-Object System.Collections.Generic.HashSet[string]; while ($true) { Get-Process -Name cmd,conhost -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { $line = "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)"; if ($seen.Add($line)) { $line } }; Start-Sleep -Milliseconds 40 }'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'orca-hook-cmd-no-window-'))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function runGrokStyleHookCommand(
  scriptPath: string,
  input = GROK_MIN_HOOK_STDIN
): { error?: Error; status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    getWindowsPowerShellExecutablePath(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `${wrapWindowsHookCommand(scriptPath)}; exit $LASTEXITCODE`
    ],
    { encoding: 'utf8', input, windowsHide: false, timeout: 20_000 }
  )
  return {
    error: result.error,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? ''
  }
}

function listTitledCmdWindows(): string[] {
  const result = spawnSync(
    getWindowsPowerShellExecutablePath(),
    [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      'Get-Process -Name cmd,conhost -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.Id)|$($_.ProcessName)|$($_.MainWindowTitle)" }'
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 }
  )
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function collectProcessOutput(child: ReturnType<typeof spawn>): {
  stdout: Promise<string>
  stderr: Promise<string>
  close: Promise<number | null>
} {
  const read = (stream: NodeJS.ReadableStream | null): Promise<string> =>
    new Promise((resolve, reject) => {
      if (!stream) {
        resolve('')
        return
      }
      const chunks: string[] = []
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => chunks.push(String(chunk)))
      stream.once('error', reject)
      stream.once('end', () => resolve(chunks.join('')))
    })
  return {
    stdout: read(child.stdout),
    stderr: read(child.stderr),
    close: new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code))
    })
  }
}

describe('Windows .cmd hook CreateNoWindow launcher', () => {
  it.skipIf(process.platform !== 'win32')(
    'relays .cmd stdout, stderr, and exit code through Grok-style powershell',
    () => {
      const scriptPath = join(tmpDir, 'orca-14828-stdio.cmd')
      writeFileSync(
        scriptPath,
        '@echo off\r\necho stdout-token\r\necho stderr-token 1>&2\r\nexit /b 7\r\n',
        'utf-8'
      )

      const result = runGrokStyleHookCommand(scriptPath)

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(7)
      expect(result.stdout.replaceAll('\r\n', '\n')).toContain('stdout-token')
      expect(result.stderr.replaceAll('\r\n', '\n')).toContain('stderr-token')
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'drains stdin and exits 0 when the managed .cmd is missing',
    () => {
      const result = runGrokStyleHookCommand(
        join(tmpDir, 'missing-orca-hook.cmd'),
        `${'x'.repeat(4096)}\n`
      )

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'preserves literal exclamation marks in .cmd output and percent-expanded env values',
    () => {
      const scriptPath = join(tmpDir, 'orca-14828-bang.cmd')
      writeFileSync(
        scriptPath,
        '@echo off\r\necho bang-!foo!bar\r\necho %ORCA_BANG_TEST%\r\nexit /b 0\r\n',
        'utf-8'
      )
      const command = wrapWindowsHookCommand(scriptPath)
      const result = spawnSync(
        getWindowsPowerShellExecutablePath(),
        ['-NoProfile', '-NonInteractive', '-Command', `${command}; exit $LASTEXITCODE`],
        {
          encoding: 'utf8',
          input: GROK_MIN_HOOK_STDIN,
          windowsHide: false,
          timeout: 20_000,
          env: { ...process.env, ORCA_BANG_TEST: 'hello!world!' }
        }
      )

      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(String(result.stdout ?? '').replaceAll('\r\n', '\n')).toContain('bang-!foo!bar')
      expect(String(result.stdout ?? '').replaceAll('\r\n', '\n')).toContain('hello!world!')
    }
  )

  it.skipIf(process.platform !== 'win32')(
    'executes a script path containing a literal exclamation mark',
    () => {
      const scriptDir = join(tmpDir, 'home with ! bang', '.orca', 'agent-hooks')
      mkdirSync(scriptDir, { recursive: true })
      const scriptPath = join(scriptDir, 'codex-hook.cmd')
      writeFileSync(scriptPath, '@echo off\r\necho path-bang-ok\r\nexit /b 7\r\n', 'utf-8')

      const result = spawnSync('cmd.exe', ['/d', '/c', wrapWindowsHookCommand(scriptPath)], {
        encoding: 'utf8'
      })

      expect(result.status).toBe(7)
      expect(String(result.stdout ?? '').replaceAll('\r\n', '\n')).toContain('path-bang-ok')
    }
  )

  it.skipIf(
    process.platform !== 'win32' || Boolean(process.env.CI) || Boolean(process.env.GITHUB_ACTIONS)
  )('does not open a titled cmd/conhost window under Grok-style powershell', async () => {
    const scriptPath = join(tmpDir, 'orca-14828-nowindow.cmd')
    writeFileSync(
      scriptPath,
      '@echo off\r\necho {"ok":true}\r\nping -n 4 127.0.0.1 >nul\r\nexit /b 0\r\n',
      'utf-8'
    )

    const before = new Set(listTitledCmdWindows())
    const sampler = spawn(
      getWindowsPowerShellExecutablePath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        titledWindowSamplerCommand
      ],
      { windowsHide: true }
    )
    const hook = spawn(
      getWindowsPowerShellExecutablePath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `${wrapWindowsHookCommand(scriptPath)}; exit $LASTEXITCODE`
      ],
      { windowsHide: false }
    )
    hook.stdin?.write(GROK_MIN_HOOK_STDIN)
    hook.stdin?.end()

    const hookOutput = collectProcessOutput(hook)
    const samplerOutput = collectProcessOutput(sampler)
    const [hookCode, hookStdout] = await Promise.all([
      hookOutput.close,
      hookOutput.stdout,
      hookOutput.stderr
    ])
    sampler.kill()
    const [samplerStdout] = await Promise.all([
      samplerOutput.stdout,
      samplerOutput.stderr,
      samplerOutput.close
    ])
    const sampled = samplerStdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !before.has(line))

    expect(hookCode).toBe(0)
    expect(hookStdout.replaceAll('\r\n', '\n')).toContain('{"ok":true}')
    expect(sampled, `new titled cmd/conhost windows: ${sampled.join(' | ')}`).toEqual([])
  })
})
