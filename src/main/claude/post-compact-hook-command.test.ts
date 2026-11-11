import { runProcess } from '@orca/process-host'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getManagedEventHook } from './hook-settings'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userData' } }))

const SCRIPT_PATH = '/home/test/.orca/agent-hooks/claude-hook.sh'

// Claude echoes the full command after /compact, so keep it short.

afterEach(() => vi.restoreAllMocks())

describe.skipIf(process.platform === 'win32')('PostCompact command execution', () => {
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-post-compact-'))
  })

  afterEach(() => rmSync(home, { recursive: true, force: true }))

  function run(command: string, env: NodeJS.ProcessEnv) {
    return runProcess({
      program: '/bin/sh',
      args: ['-c', command],
      env: { PATH: '/usr/bin:/bin', ...env },
      input: 'x'.repeat(1_000_000),
      timeoutMs: 5_000
    })
  }

  it('runs the HOME script with the agent pid captured', async () => {
    const dir = join(home, '.orca', 'agent-hooks')
    mkdirSync(dir, { recursive: true })
    const script = join(dir, 'claude-hook.sh')
    writeFileSync(script, '#!/bin/sh\ncat >/dev/null\nprintf "%s" "$ORCA_HOOK_AGENT_PID"\nexit 7\n')
    chmodSync(script, 0o755)

    const result = await run(getManagedEventHook('PostCompact', SCRIPT_PATH).command, {
      HOME: home
    })

    expect(result.code, result.stderr).toBe(7)
    expect(result.stdout).toBe(String(process.pid))
  })

  it.each([
    ['the script is missing', (dir: string) => ({ HOME: dir })],
    ['HOME is empty', () => ({ HOME: '' })],
    ['HOME is unset', () => ({})]
  ])('drains stdin silently when %s', async (_label, env) => {
    const result = await run(getManagedEventHook('PostCompact', SCRIPT_PATH).command, env(home))

    expect(result.code).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })
})
