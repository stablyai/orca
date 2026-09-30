import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getGrokManagedScript } from './grok-hook-script'

// Grok's own hook timeout; the budget these cases have to stay well inside.
const GROK_HOOK_TIMEOUT_MS = 10_000
const SESSION_START_BUDGET_MS = 1_500

describe.skipIf(process.platform === 'win32')('Grok POSIX hook stdin without EOF', () => {
  let dir = ''

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /** Writes the payload and leaves the pipe open, which is what Grok SessionStart does. */
  async function runHookWithoutEof(
    chunks: readonly Buffer[]
  ): Promise<{ exitCode: number | null; durationMs: number; stderr: string }> {
    dir = mkdtempSync(join(tmpdir(), 'orca-grok-hook-no-eof-'))
    const scriptPath = join(dir, 'grok-hook.sh')
    writeFileSync(scriptPath, getGrokManagedScript('posix'), { mode: 0o755 })

    const startedAt = Date.now()
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
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.stdin.on('error', () => {})

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`hook still blocked on stdin after ${GROK_HOOK_TIMEOUT_MS}ms`))
      }, GROK_HOOK_TIMEOUT_MS)
      child.on('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timeout)
        resolve(code)
      })
      void (async () => {
        for (const chunk of chunks) {
          child.stdin.write(chunk)
          await new Promise((resolveGap) => setTimeout(resolveGap, 5))
        }
      })()
    })

    return { exitCode, durationMs: Date.now() - startedAt, stderr }
  }

  it('returns after one JSON object when the caller never closes stdin (SessionStart)', async () => {
    const result = await runHookWithoutEof([
      Buffer.from('{"hook_event_name":"session_start","session_id":"abc"}\n')
    ])

    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBeLessThan(SESSION_START_BUDGET_MS)
  })

  // Why: a non-ASCII payload arriving in pieces used to crash the reader, which
  // fell through to `cat` and reinstated the very 10s timeout this hook avoids.
  it('returns just as fast when a multi-byte payload is split across writes', async () => {
    const bytes = Buffer.from(
      '{"hook_event_name":"session_start","cwd":"/tmp/漢字","tool":"🚀"}\n',
      'utf8'
    )
    const result = await runHookWithoutEof([...bytes].map((byte) => Buffer.from([byte])))

    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.durationMs).toBeLessThan(SESSION_START_BUDGET_MS)
  }, 20_000)
})
