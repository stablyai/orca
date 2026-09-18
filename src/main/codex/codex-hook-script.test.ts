import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getManagedScript } from './codex-hook-script'

describe('Codex managed hook runner', () => {
  it('uses a bounded reader and emits neutral JSON when Orca is unavailable', () => {
    const script = getManagedScript('posix')
    expect(script).toContain('orca_hook_json_stdin_py')
    expect(script).toContain('python3')
    expect(script).not.toContain('|| { command -p cat')
    expect(script).toContain("printf '{}\\n'")
  })

  it('returns after a complete payload even when the caller keeps stdin open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-codex-hook-script-'))
    const scriptPath = join(dir, 'codex-hook.sh')
    writeFileSync(scriptPath, getManagedScript('posix'), 'utf8')
    chmodSync(scriptPath, 0o755)

    try {
      const result = await new Promise<{ status: number | null; stdout: string }>(
        (resolve, reject) => {
          const child = spawn('/bin/sh', [scriptPath], {
            env: Object.fromEntries(
              Object.entries(process.env).filter(([key]) => !key.startsWith('ORCA_'))
            ),
            stdio: ['pipe', 'pipe', 'ignore']
          })
          let stdout = ''
          child.stdout.setEncoding('utf8')
          child.stdout.on('data', (chunk: string) => {
            stdout += chunk
          })
          const timer = setTimeout(() => {
            child.kill('SIGKILL')
            reject(new Error('Codex hook did not return with an open stdin'))
          }, 4_000)
          child.on('error', (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.on('close', (status) => {
            clearTimeout(timer)
            resolve({ status, stdout })
          })
          child.stdin.write('{"hook_event_name":"Stop","cwd":"/tmp"}')
          // Intentionally leave stdin open: Codex's bridge keeps the pipe alive.
        }
      )

      expect(result.status).toBe(0)
      expect(result.stdout).toBe('{}\n')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 8_000)
})
