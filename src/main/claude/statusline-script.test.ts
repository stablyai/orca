import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS } from '../../shared/claude-statusline-rate-limits'
import { getManagedStatusLineScript } from './statusline-script'

const ORIGINAL_PLATFORM = process.platform

function stubPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: ORIGINAL_PLATFORM })
})

describe('getManagedStatusLineScript (posix)', () => {
  it('guards on rate_limits before sourcing the endpoint or spawning curl', () => {
    stubPlatform('darwin')
    const script = getManagedStatusLineScript('local')
    expect(script).toBe(getManagedStatusLineScript('posix'))
    const guardIndex = script.indexOf('*\'"rate_limits"\'*')
    const endpointIndex = script.indexOf('ORCA_AGENT_HOOK_ENDPOINT')
    const curlIndex = script.indexOf('curl -sS')
    expect(guardIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(endpointIndex)
    expect(endpointIndex).toBeLessThan(curlIndex)
    expect(script).toContain('/statusline/claude')
    expect(script).toContain('--data-urlencode "payload@-"')
  })

  it('returns the posix script even on win32 when targeting a remote', () => {
    stubPlatform('win32')
    const script = getManagedStatusLineScript('posix')
    expect(script).toContain('#!/bin/sh')
    expect(script).not.toContain('curl.exe')
  })
})

describe('getManagedStatusLineScript (win32 local)', () => {
  it('guards on rate_limits via findstr before the endpoint call and curl spawn', () => {
    stubPlatform('win32')
    const script = getManagedStatusLineScript('local')
    const captureIndex = script.indexOf('more.com')
    // Why: the \"-escaped needle makes findstr match the quoted JSON key, not any path containing rate_limits.
    const guardIndex = script.indexOf('findstr.exe" /c:\\"rate_limits\\"')
    const endpointIndex = script.indexOf('call "%ORCA_AGENT_HOOK_ENDPOINT%"')
    const curlIndex = script.indexOf('curl.exe')
    expect(captureIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeGreaterThan(captureIndex)
    expect(guardIndex).toBeLessThan(endpointIndex)
    expect(endpointIndex).toBeLessThan(curlIndex)
    expect(script).toContain('if errorlevel 1 goto :orca_statusline_cleanup')
  })

  it('posts the buffered payload file and deletes it afterwards', () => {
    stubPlatform('win32')
    const script = getManagedStatusLineScript('local')
    // Why: the stable leaf UUID stays filename-safe even when a host-supplied tab id does not,
    // while the delimiter replacement keeps a surviving legacy numeric key valid on Windows.
    expect(script).toContain('set "ORCA_STATUSLINE_PANE_ID=%ORCA_PANE_KEY:~-36%"')
    expect(script).toContain('set "ORCA_STATUSLINE_PANE_ID=%ORCA_STATUSLINE_PANE_ID::=_%"')
    expect(script).toContain(
      'set "ORCA_STATUSLINE_PAYLOAD_FILE=%TEMP%\\orca-claude-statusline-%ORCA_STATUSLINE_PANE_ID%.tmp"'
    )
    expect(script).toContain('--data-urlencode "payload@%ORCA_STATUSLINE_PAYLOAD_FILE%"')
    expect(script).not.toContain('payload@-')
    const curlIndex = script.indexOf('curl.exe')
    const delIndex = script.indexOf('del "%ORCA_STATUSLINE_PAYLOAD_FILE%"')
    expect(delIndex).toBeGreaterThan(curlIndex)
  })

  it('never posts a literal %CLAUDE_CONFIG_DIR% token when the var is unset', () => {
    stubPlatform('win32')
    const script = getManagedStatusLineScript('local')
    // Why: the posted field comes from an always-defined variable so an unset
    // CLAUDE_CONFIG_DIR yields "configDir=" (matching POSIX + the null snapshot).
    expect(script).toContain('set "ORCA_STATUSLINE_CONFIG_DIR_FIELD=configDir="')
    expect(script).toContain(
      'if defined CLAUDE_CONFIG_DIR set "ORCA_STATUSLINE_CONFIG_DIR_FIELD=configDir=%CLAUDE_CONFIG_DIR%"'
    )
    expect(script).toContain('--data-urlencode "%ORCA_STATUSLINE_CONFIG_DIR_FIELD%"')
    expect(script).not.toContain('"configDir=%CLAUDE_CONFIG_DIR%"')
  })

  it('drains stdin before exiting when the pane key is missing', () => {
    stubPlatform('win32')
    const script = getManagedStatusLineScript('local')
    const paneGuardIndex = script.indexOf(
      'if "%ORCA_PANE_KEY%"=="" goto :orca_agent_hook_drain_stdin'
    )
    const captureIndex = script.indexOf('more.com')
    expect(paneGuardIndex).toBeGreaterThan(-1)
    expect(paneGuardIndex).toBeLessThan(captureIndex)
    expect(script).toContain(':orca_agent_hook_drain_stdin')
  })

  it('throttles with an all-builtin seconds-of-day stamp that fails open to posting', () => {
    stubPlatform('win32')
    const script = getManagedStatusLineScript('local')
    const captureIndex = script.indexOf('more.com')
    const stampIndex = script.indexOf(
      'set "ORCA_STATUSLINE_STAMP_FILE=%TEMP%\\orca-claude-statusline-last-%ORCA_STATUSLINE_PANE_ID%.tmp"'
    )
    const throttleIndex = script.indexOf(
      `if %ORCA_STATUSLINE_ELAPSED% GEQ 0 if %ORCA_STATUSLINE_ELAPSED% LSS ${CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS} goto :orca_statusline_cleanup`
    )
    const findstrIndex = script.indexOf('findstr.exe')
    const stampWriteIndex = script.indexOf(
      'if defined ORCA_STATUSLINE_NOW (>"%ORCA_STATUSLINE_STAMP_FILE%" echo %ORCA_STATUSLINE_NOW%)'
    )
    const tokenGuardIndex = script.indexOf('if "%ORCA_AGENT_HOOK_TOKEN%"=="" goto')
    const curlIndex = script.indexOf('curl.exe')
    // Why: the check precedes findstr so throttled ticks skip that spawn too, but the stamp
    // only advances after every post guard passes — skipped ticks must not defer the next post.
    expect(stampIndex).toBeGreaterThan(captureIndex)
    expect(throttleIndex).toBeGreaterThan(stampIndex)
    expect(throttleIndex).toBeLessThan(findstrIndex)
    expect(stampWriteIndex).toBeGreaterThan(tokenGuardIndex)
    expect(stampWriteIndex).toBeLessThan(curlIndex)
    // Fail-open shape: undefined elapsed (unparseable time/stamp) proceeds to the probe.
    expect(script).toContain('if not defined ORCA_STATUSLINE_ELAPSED goto :orca_statusline_probe')
    expect(script).toContain(
      'for /f "delims=0123456789" %%d in ("%ORCA_STATUSLINE_LAST%") do set "ORCA_STATUSLINE_LAST="'
    )
    expect(script).toContain(
      'if defined ORCA_STATUSLINE_NOW if defined ORCA_STATUSLINE_LAST set /a "ORCA_STATUSLINE_ELAPSED=ORCA_STATUSLINE_NOW-ORCA_STATUSLINE_LAST" 2>nul'
    )
    // cmd parses leading-zero numbers as octal; 1%%x %% 100 defuses 08/09.
    expect(script).toContain('(1%%a %% 100)*3600+(1%%b %% 100)*60+(1%%c %% 100)')
    expect(script).toContain('set "ORCA_STATUSLINE_TIME=%TIME: =0%"')
  })
})

describe('statusline curl throttle (posix)', () => {
  it('checks the per-pane stamp after the env guards and before curl', () => {
    stubPlatform('darwin')
    const script = getManagedStatusLineScript('local')
    const envGuardIndex = script.indexOf('-z "$ORCA_AGENT_HOOK_PORT"')
    const durationIndex = script.indexOf('"total_duration_ms"')
    const stampIndex = script.indexOf('orca-claude-statusline-last-${orca_statusline_pane_id}')
    const intervalIndex = script.indexOf(`-lt ${CLAUDE_STATUSLINE_MIN_POST_INTERVAL_SECONDS}`)
    const curlIndex = script.indexOf('curl -sS')
    expect(envGuardIndex).toBeLessThan(stampIndex)
    expect(stampIndex).toBeLessThan(durationIndex)
    expect(durationIndex).toBeLessThan(intervalIndex)
    expect(intervalIndex).toBeLessThan(curlIndex)
    // Fail-open shape: non-numeric date output or stamp content must never suppress the post.
    // Why: the allow-list (not a mere digits check) matters — leading-zero values like 008 are
    // invalid octal inside $(( )) and abort the whole script under dash, wedging the stamp.
    expect(script).toContain(
      'case "$orca_statusline_now" in 0|[1-9]|[1-9][0-9]*) ;; *) orca_statusline_now='
    )
    expect(script).toContain(
      'case "$orca_statusline_last" in 0|[1-9]|[1-9][0-9]*) ;; *) orca_statusline_last='
    )
  })
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
    // Why: the stamp check/write is deliberately lock-free — a lock could wedge the feed closed,
    // and fail-open is the contract — so a truly concurrent burst may post more than once,
    // bounded by the overlap width. The deterministic invariants are: every overlapping run
    // exits 0, the raced stamp still lands valid, and it throttles the very next ticks.
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

  it('fails open on a garbage stamp even early in a session', async () => {
    const { scriptPath, dir, curlLog } = makeHarness()
    writeFileSync(stampPathFor(dir), 'not-a-number')
    await runScript(scriptPath, dir, rateLimitPayload(1_000))
    expect(lineCount(curlLog)).toBe(1)
    expect(readFileSync(stampPathFor(dir), 'utf8')).toMatch(/^[0-9]+$/)
  })

  it('fails open and repairs a leading-zero stamp instead of dying in arithmetic', async () => {
    const { scriptPath, dir, curlLog } = makeHarness()
    // Why: 008 is all-digits but invalid octal inside $(( )) — under dash the old digits-only
    // check made the script abort before rewriting the stamp, wedging this pane's feed dark.
    writeFileSync(stampPathFor(dir), '008')
    await runScript(scriptPath, dir, rateLimitPayload(1_000))
    expect(lineCount(curlLog)).toBe(1)
    expect(readFileSync(stampPathFor(dir), 'utf8')).toBe('1')
  })

  it('uses the clock fallback when the payload omits session duration', async () => {
    const { scriptPath, dir, curlLog, dateLog } = makeHarness()
    const payload = '{"rate_limits":{"five_hour":{"used_percentage":12}}}'
    await runScript(scriptPath, dir, payload)
    await runScript(scriptPath, dir, payload)
    expect(lineCount(curlLog)).toBe(1)
    expect(lineCount(dateLog)).toBe(2)
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
