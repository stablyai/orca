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
  const LEAF_ID = '00000000-0000-4000-8000-000000000000'
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

  function lineCount(logPath: string): number {
    try {
      return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }

  function stampPathFor(dir: string, leafId = LEAF_ID): string {
    return join(dir, `orca-claude-statusline-last-${leafId}`)
  }

  it('spawns one curl and no capture or clock subprocesses across 30 rapid ticks', async () => {
    const { scriptPath, dir, curlLog, dateLog, catLog } = makeHarness()
    for (let index = 0; index < 30; index += 1) {
      await runScript(scriptPath, dir, rateLimitPayload(1_000 + index * 100))
    }
    expect(lineCount(curlLog)).toBe(1)
    expect(lineCount(dateLog)).toBe(0)
    expect(lineCount(catLog)).toBe(0)
    expect(readFileSync(stampPathFor(dir), 'utf8')).toMatch(/^[0-9]+$/)
  })

  it('posts again once the interval has elapsed', async () => {
    const { scriptPath, dir, curlLog } = makeHarness()
    await runScript(scriptPath, dir, rateLimitPayload(1_000))
    await runScript(scriptPath, dir, rateLimitPayload(16_000))
    expect(lineCount(curlLog)).toBe(2)
  })

  it('stays bounded and keeps a valid stamp under overlapping same-pane ticks', async () => {
    const { scriptPath, dir, curlLog } = makeHarness()
    // Lock-free stamps fail open: overlapping ticks may post more than once but must throttle subsequent ticks.
    await Promise.all(
      Array.from({ length: 10 }, () => runScript(scriptPath, dir, rateLimitPayload(1_000)))
    )
    const burstPosts = lineCount(curlLog)
    expect(burstPosts).toBeGreaterThanOrEqual(1)
    expect(readFileSync(stampPathFor(dir), 'utf8')).toBe('1')
    for (let index = 0; index < 5; index += 1) {
      await runScript(scriptPath, dir, rateLimitPayload(2_000 + index * 100))
    }
    expect(lineCount(curlLog)).toBe(burstPosts)
  })

  it('preserves multiline payloads while capturing stdin with shell builtins', async () => {
    const { scriptPath, dir, payloadLog } = makeHarness()
    const payload = JSON.stringify(JSON.parse(rateLimitPayload(1_000)), null, 2)
    await runScript(scriptPath, dir, payload)
    expect(readFileSync(payloadLog, 'utf8')).toBe(payload)
  })

  it('fails open and repairs a leading-zero stamp instead of dying in arithmetic', async () => {
    const { scriptPath, dir, curlLog } = makeHarness()
    // 008 is invalid octal in dash arithmetic and must not prevent stamp repair.
    writeFileSync(stampPathFor(dir), '008')
    await runScript(scriptPath, dir, rateLimitPayload(1_000))
    expect(lineCount(curlLog)).toBe(1)
    expect(readFileSync(stampPathFor(dir), 'utf8')).toBe('1')
  })

  it('uses only the stable leaf id for temp files', async () => {
    const { scriptPath, dir, curlLog } = makeHarness()
    const paneKey = `${'path/segment/'.repeat(30)}tab:${LEAF_ID}`
    await runScript(scriptPath, dir, rateLimitPayload(1_000), paneKey)
    await runScript(scriptPath, dir, rateLimitPayload(2_000), paneKey)
    expect(lineCount(curlLog)).toBe(1)
    expect(readFileSync(stampPathFor(dir), 'utf8')).toBe('1')
  })

  it('keeps legacy numeric pane ids isolated by tab', async () => {
    const { scriptPath, dir, curlLog } = makeHarness()
    await runScript(scriptPath, dir, rateLimitPayload(1_000), 'legacy-tab-a:1')
    await runScript(scriptPath, dir, rateLimitPayload(1_000), 'legacy-tab-b:1')
    expect(lineCount(curlLog)).toBe(2)
    expect(readFileSync(stampPathFor(dir, 'legacy-tab-a_1'), 'utf8')).toBe('1')
    expect(readFileSync(stampPathFor(dir, 'legacy-tab-b_1'), 'utf8')).toBe('1')
  })

  it('never touches curl or the stamp for payloads without rate_limits', async () => {
    const { scriptPath, dir, curlLog, dateLog } = makeHarness()
    await runScript(scriptPath, dir, '{"model":{"id":"claude-fable-5"}}')
    expect(lineCount(curlLog)).toBe(0)
    expect(lineCount(dateLog)).toBe(0)
    expect(() => readFileSync(stampPathFor(dir), 'utf8')).toThrow()
  })
})
