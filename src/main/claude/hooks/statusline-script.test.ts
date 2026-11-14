import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getManagedStatusLineScript } from './statusline-script'

const ORIGINAL_PLATFORM = process.platform

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: ORIGINAL_PLATFORM })
})

describe.skipIf(process.platform === 'win32')('statusline curl throttle (posix behavioral)', () => {
  const PANE_KEY = 'tab-1:00000000-0000-4000-8000-000000000000'
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function rateLimitPayload(durationMs: number): string {
    return JSON.stringify({
      cost: { total_duration_ms: durationMs },
      rate_limits: { five_hour: { used_percentage: 12 } }
    })
  }

  function makeHarness(): {
    scriptPath: string
    dir: string
    curlLog: string
    payloadLog: string
    dateLog: string
    catLog: string
  } {
    const dir = mkdtempSync(join(tmpdir(), 'orca-statusline-throttle-'))
    dirs.push(dir)
    const curlLog = join(dir, 'curl.log')
    const payloadLog = join(dir, 'payload.log')
    const dateLog = join(dir, 'date.log')
    const catLog = join(dir, 'cat.log')
    const scriptPath = join(dir, 'statusline.sh')
    writeFileSync(scriptPath, getManagedStatusLineScript('posix'))
    const binDir = join(dir, 'stub-bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      join(binDir, 'curl'),
      `#!/bin/sh\n/bin/cat > "${payloadLog}"\nprintf 'x\\n' >> "${curlLog}"\nexit 0\n`,
      { mode: 0o755 }
    )
    writeFileSync(
      join(binDir, 'date'),
      `#!/bin/sh\nprintf 'x\\n' >> "${dateLog}"\nprintf '2000000000\\n'\n`,
      { mode: 0o755 }
    )
    writeFileSync(join(binDir, 'cat'), `#!/bin/sh\nprintf 'x\\n' >> "${catLog}"\n/bin/cat "$@"\n`, {
      mode: 0o755
    })
    return { scriptPath, dir, curlLog, payloadLog, dateLog, catLog }
  }

  function runScript(
    scriptPath: string,
    dir: string,
    payload: string,
    paneKey = PANE_KEY
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('sh', [scriptPath], {
        env: {
          PATH: `${join(dir, 'stub-bin')}:${process.env.PATH ?? ''}`,
          TMPDIR: dir,
          ORCA_AGENT_HOOK_PORT: '65535',
          ORCA_AGENT_HOOK_TOKEN: 'test-token',
          ORCA_PANE_KEY: paneKey
        },
        stdio: ['pipe', 'ignore', 'pipe']
      })
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`statusline script exited ${code}: ${stderr}`))
        }
      })
      child.stdin.write(payload)
      child.stdin.end()
    })
  }

  it('preserves multiline payloads while capturing stdin with shell builtins', async () => {
    const { scriptPath, dir, payloadLog } = makeHarness()
    const payload = JSON.stringify(JSON.parse(rateLimitPayload(1_000)), null, 2)
    await runScript(scriptPath, dir, payload)
    expect(readFileSync(payloadLog, 'utf8')).toBe(payload)
  })
})
