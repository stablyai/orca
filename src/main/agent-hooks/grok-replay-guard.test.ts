import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

import { getManagedScript as getClaudeManagedScript } from '../claude/hook-service'
import { getManagedScript as getCursorManagedScript } from '../cursor/hook-script'

const POSIX_GROK_GUARD = 'if [ -n "$GROK_HOOK_EVENT" ]; then'

const WINDOWS_GROK_GUARD = 'if not "%GROK_HOOK_EVENT%"=="" goto :orca_agent_hook_drain_stdin'

const CLAUDE_SCRIPT_OPTIONS = {
  skipWhenDevinImportsClaude: true,
  skipWhenGrokImportsClaude: true
}

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })

  try {
    return run()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

function expectGuardBeforeTransport(
  script: string,
  guard: string,
  response: string,
  spool?: string
): void {
  const guardIndex = script.indexOf(guard)
  expect(guardIndex).toBeGreaterThan(script.indexOf(response))
  expect(guardIndex).toBeLessThan(script.indexOf('curl'))

  if (spool) {
    expect(guardIndex).toBeLessThan(script.indexOf(spool))
  }
}

function runPosixHook(
  script: string,
  grokHookEvent: string
): {
  curlCalled: boolean
  stdout: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'orca-grok-replay-'))
  const scriptPath = join(dir, 'hook.sh')
  const curlPath = join(dir, 'curl')
  const curlLog = join(dir, 'curl.log')

  try {
    writeFileSync(scriptPath, script)
    writeFileSync(
      curlPath,
      '#!/bin/sh\n{ command -p cat 2>/dev/null || cat; } >/dev/null\nprintf "called\\n" >> "$CURL_LOG"\n'
    )
    chmodSync(scriptPath, 0o755)
    chmodSync(curlPath, 0o755)

    const result = spawnSync('/bin/sh', [scriptPath], {
      encoding: 'utf8',
      input: '{"hook_event_name":"Stop"}',
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        CURL_LOG: curlLog,
        GROK_HOOK_EVENT: grokHookEvent,
        ORCA_AGENT_HOOK_ENDPOINT: '',
        ORCA_AGENT_HOOK_PORT: '1234',
        ORCA_AGENT_HOOK_TOKEN: 'token',
        ORCA_PANE_KEY: 'tab:leaf'
      }
    })

    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)

    return { curlCalled: existsSync(curlLog), stdout: result.stdout }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Grok vendor hook replay guard', () => {
  it('precedes spooling and HTTP in the generated POSIX Claude and Cursor scripts', () => {
    const claude = getClaudeManagedScript('posix', CLAUDE_SCRIPT_OPTIONS)
    const cursor = getCursorManagedScript('posix')

    expectGuardBeforeTransport(claude, POSIX_GROK_GUARD, 'printf "{}\\n"', 'spool_hook_event')
    expectGuardBeforeTransport(cursor, POSIX_GROK_GUARD, 'printf "{}\\n"', 'spool_hook_event')
  })

  it('precedes HTTP while preserving fail-open output in generated Windows scripts', () => {
    const { claude, cursor } = withPlatform('win32', () => ({
      claude: getClaudeManagedScript('local', CLAUDE_SCRIPT_OPTIONS),
      cursor: getCursorManagedScript('local')
    }))

    expectGuardBeforeTransport(claude, WINDOWS_GROK_GUARD, 'echo {}')
    expectGuardBeforeTransport(cursor, WINDOWS_GROK_GUARD, '(echo {})')
    const backgroundWorkerGuardIndex = claude.indexOf('CLAUDE_JOB_DIR')
    expect(backgroundWorkerGuardIndex).toBeGreaterThan(-1)
    expect(backgroundWorkerGuardIndex).toBeLessThan(claude.indexOf(WINDOWS_GROK_GUARD))
  })

  it.skipIf(process.platform === 'win32')(
    'drops Grok-replayed hooks without suppressing their protocol response',
    () => {
      for (const script of [
        getClaudeManagedScript('posix', CLAUDE_SCRIPT_OPTIONS),
        getCursorManagedScript('posix')
      ]) {
        const result = runPosixHook(script, 'Stop')
        expect(result.curlCalled).toBe(false)
        expect(result.stdout).toBe('{}\n')
      }
    }
  )

  it.skipIf(process.platform === 'win32')('leaves non-Grok hook delivery unchanged', () => {
    for (const script of [
      getClaudeManagedScript('posix', CLAUDE_SCRIPT_OPTIONS),
      getCursorManagedScript('posix')
    ]) {
      const result = runPosixHook(script, '')
      expect(result.curlCalled).toBe(true)
      expect(result.stdout).toBe('{}\n')
    }
  })
})
