import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getGrokManagedScript } from './grok-hook-script'

describe.skipIf(process.platform === 'win32')('Grok POSIX hook stdin without EOF', () => {
  let dir = ''

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns after one JSON object when the caller never closes stdin (SessionStart)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-grok-hook-no-eof-'))
    const scriptPath = join(dir, 'grok-hook.sh')
    writeFileSync(scriptPath, getGrokManagedScript('posix'), { mode: 0o755 })

    const child = spawn('/bin/sh', [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ORCA_PANE_KEY: 'pane-1',
        ORCA_AGENT_HOOK_PORT: '',
        ORCA_AGENT_HOOK_TOKEN: '',
        ORCA_AGENT_HOOK_ENDPOINT: ''
      }
    })

    child.stdin.write('{"hook_event_name":"session_start","session_id":"abc"}\n')
    // Intentionally do not end stdin: Grok SessionStart leaves the pipe open
    // until the hook exits, which used to deadlock `cat` for 10s.

    const started = Date.now()
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error('hook still blocked on stdin after 2s'))
      }, 2_000)
      child.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timeout)
        resolve(code)
      })
    })

    expect(exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(1_500)
  })
})
