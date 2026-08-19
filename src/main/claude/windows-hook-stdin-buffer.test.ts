import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANAGED_HOOK_TIMEOUT_SECONDS,
  buildWindowsAgentHookCurlPostCommand
} from '../agent-hooks/installer-utils'
import { buildWindowsHookStdinDrainEpilogue } from '../agent-hooks/hook-stdin-contract'
import { HOOK_REQUEST_MAX_BYTES } from '../../shared/agent-hook-listener'
import {
  CLAUDE_EVENTS,
  CLAUDE_HOOK_SETTINGS,
  OPENCLAUDE_HOOK_SETTINGS,
  applyManagedHooks,
  getManagedLifecycleHook
} from './hook-settings'
import {
  WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV,
  WINDOWS_CLAUDE_HOOK_DESCENDANT_BUDGET_MILLISECONDS,
  WINDOWS_CLAUDE_HOOK_STDIN_MAX_BYTES,
  WINDOWS_CLAUDE_HOOK_STDIN_TOTAL_TIMEOUT_MILLISECONDS,
  buildWindowsClaudeHookStdinBuffer
} from './windows-hook-stdin-buffer'

function decodePowerShellCommand(command: string): string {
  const encoded = command.match(/ -EncodedCommand (\S+)$/)?.[1]
  return Buffer.from(encoded ?? '', 'base64').toString('utf16le')
}

async function runWindowsHook(
  command: string,
  env: NodeJS.ProcessEnv,
  chunks: readonly { delay: number; value: string }[]
): Promise<{ code: number | null; stdout: string }> {
  const child = spawn('cmd.exe', ['/d', '/c', command], {
    env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  let stdout = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (data: string) => {
    stdout += data
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error('Windows hook did not exit'))
    }, 5_000)
    const settle = (result: () => void): void => {
      clearTimeout(timeout)
      result()
    }
    child.once('error', (error) => settle(() => reject(error)))
    child.once('close', (exitCode) => settle(() => resolve(exitCode)))

    void (async () => {
      for (const chunk of chunks) {
        await new Promise((delayDone) => setTimeout(delayDone, chunk.delay))
        if (child.exitCode !== null || child.killed) {
          return
        }
        await new Promise<void>((writeDone, writeFailed) => {
          child.stdin.write(chunk.value, (error) => (error ? writeFailed(error) : writeDone()))
        })
      }
    })().catch((error: unknown) => {
      settle(() => reject(error))
    })
  })
  return { code, stdout }
}

describe('Windows Claude hook stdin buffer', () => {
  it('bounds the reader before launching children and owns payload-file cleanup', () => {
    const command = buildWindowsClaudeHookStdinBuffer('& $scriptPath')

    expect(command).toContain('$i.ReadAsync')
    expect(command).toContain('$r.Wait($u)')
    expect(command).toContain(
      `$w.ElapsedMilliseconds -lt ${WINDOWS_CLAUDE_HOOK_STDIN_TOTAL_TIMEOUT_MILLISECONDS}`
    )
    expect(command).toContain('$t.Cancel()')
    expect(command).toContain(`$p.Length -lt ${WINDOWS_CLAUDE_HOOK_STDIN_MAX_BYTES}`)
    expect(WINDOWS_CLAUDE_HOOK_STDIN_MAX_BYTES).toBe(HOOK_REQUEST_MAX_BYTES)
    expect(
      WINDOWS_CLAUDE_HOOK_STDIN_TOTAL_TIMEOUT_MILLISECONDS +
        WINDOWS_CLAUDE_HOOK_DESCENDANT_BUDGET_MILLISECONDS
    ).toBe(MANAGED_HOOK_TIMEOUT_SECONDS * 1_000)
    expect(command).toContain("if (-not $c -or $x) { Write-Output '{}'; exit 0 }")
    expect(command).toContain('ConvertFrom-Json')
    expect(command).toContain("Join-Path ([System.IO.Path]::GetTempPath()) 'orca-claude-hooks'")
    expect(command).toContain("Get-ChildItem -LiteralPath $g -Filter '*.json'")
    expect(command).toContain('[System.IO.File]::WriteAllBytes($f, $p.ToArray())')
    expect(command).toContain('Remove-Item -LiteralPath $f -Force')
    expect(command).toContain(`$env:${WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV} = $f`)
    const payloadPathIndex = command.indexOf('$f = Join-Path $g')
    const payloadCleanupTryIndex = command.indexOf('  try {', payloadPathIndex)
    expect(payloadCleanupTryIndex).toBeLessThan(
      command.indexOf('[System.IO.File]::WriteAllBytes($f, $p.ToArray())')
    )
    expect(command.indexOf('ORCA_PANE_KEY')).toBeLessThan(command.indexOf('$i.ReadAsync'))
    expect(command.indexOf('$i.ReadAsync')).toBeLessThan(command.indexOf('& $scriptPath'))
  })

  it('generates the bounded launcher only for local Windows Claude settings', () => {
    const windowsClaude = getManagedLifecycleHook(
      'C:\\Users\\test\\.orca\\agent-hooks\\claude-hook.cmd',
      CLAUDE_HOOK_SETTINGS,
      'win32'
    )
    const windowsOpenClaude = getManagedLifecycleHook(
      'openclaude-hook.cmd',
      OPENCLAUDE_HOOK_SETTINGS,
      'win32'
    )
    const posixClaude = getManagedLifecycleHook(
      '/home/test/.orca/agent-hooks/claude-hook.sh',
      CLAUDE_HOOK_SETTINGS,
      'linux'
    )

    expect(decodePowerShellCommand(windowsClaude.command)).toContain('$i.ReadAsync')
    expect(windowsClaude.command.length).toBeLessThanOrEqual(8_191)
    expect(windowsClaude.timeout).toBe(MANAGED_HOOK_TIMEOUT_SECONDS)
    expect(decodePowerShellCommand(windowsOpenClaude.command)).toBe('')
    expect(windowsOpenClaude.timeout).toBe(MANAGED_HOOK_TIMEOUT_SECONDS)
    expect(decodePowerShellCommand(posixClaude.command)).toBe('')
    expect(posixClaude.timeout).toBe(MANAGED_HOOK_TIMEOUT_SECONDS)

    const generated = applyManagedHooks({}, windowsClaude)
    expect(Object.keys(generated.hooks ?? {})).toHaveLength(CLAUDE_EVENTS.length)
    for (const event of CLAUDE_EVENTS) {
      expect(generated.hooks?.[event.eventName]?.[0]?.hooks).toEqual([windowsClaude])
    }
  })

  it('feeds curl and the drain from the closed payload file while preserving generic stdin readers', () => {
    const claudeCurl = buildWindowsAgentHookCurlPostCommand(
      'claude',
      WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV
    )
    expect(claudeCurl).toContain(
      `--data-urlencode "payload@%${WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV}%"`
    )
    expect(buildWindowsAgentHookCurlPostCommand('codex')).toContain('--data-urlencode "payload@-"')

    const claudeDrain = buildWindowsHookStdinDrainEpilogue(
      WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV
    ).join('\r\n')
    expect(claudeDrain).toContain(`< "%${WINDOWS_CLAUDE_HOOK_PAYLOAD_FILE_ENV}%" >nul 2>nul`)
    expect(buildWindowsHookStdinDrainEpilogue().join('\r\n')).toContain('more.com" >nul 2>nul')
  })

  it.skipIf(process.platform !== 'win32')(
    'runs complete fragmented JSON without waiting for EOF and guards missing context before reading',
    async () => {
      const home = mkdtempSync(join(tmpdir(), 'orca-claude-stdin-buffer-'))
      const scriptDir = join(home, '.orca', 'agent-hooks')
      const capturePath = join(home, 'captured.json')
      mkdirSync(scriptDir, { recursive: true })
      writeFileSync(
        join(scriptDir, 'claude-hook.cmd'),
        [
          '@echo off',
          'copy /y "%ORCA_AGENT_HOOK_PAYLOAD_FILE%" "%ORCA_TEST_CAPTURE%" >nul',
          'echo {}',
          'exit /b 0'
        ].join('\r\n')
      )
      const hook = getManagedLifecycleHook('claude-hook.cmd', CLAUDE_HOOK_SETTINGS, 'win32')
      const env = {
        ...process.env,
        USERPROFILE: home,
        ORCA_AGENT_HOOK_PORT: '1',
        ORCA_AGENT_HOOK_TOKEN: 'token',
        ORCA_PANE_KEY: 'pane',
        ORCA_TEST_CAPTURE: capturePath
      }
      try {
        const payload = '{"hook_event_name":"Stop","value":"✓"}'
        const split = payload.indexOf(',') + 1
        const result = await runWindowsHook(hook.command, env, [
          { delay: 0, value: payload.slice(0, split) },
          { delay: 1_200, value: payload.slice(split) }
        ])
        expect(result.code).toBe(0)
        expect(result.stdout.trim()).toBe('{}')
        expect(readFileSync(capturePath, 'utf8')).toBe(payload)

        rmSync(capturePath)
        const startedAt = Date.now()
        const missingContext = await runWindowsHook(
          hook.command,
          { ...process.env, USERPROFILE: home, ORCA_TEST_CAPTURE: capturePath },
          []
        )
        expect(missingContext.code).toBe(0)
        expect(missingContext.stdout.trim()).toBe('{}')
        expect(Date.now() - startedAt).toBeLessThan(2_000)
        expect(() => readFileSync(capturePath)).toThrow()
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    }
  )
})
