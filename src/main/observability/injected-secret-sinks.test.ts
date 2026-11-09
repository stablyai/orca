import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  sanitizeCrashReportDetails,
  sanitizeCrashReportString
} from '../../shared/crash-report-redaction'
import { registerRedactedSecretValue } from '../../shared/redacted-secret-values'
import { createDaemonFileLog } from '../daemon/observability/daemon-file-log'

// Every sink outside the observability tracer that can receive launch env, RPC params or error text
// must strip injected credentials: crash reports, the daemon's file log and the emulator probe.
const STORED_KEY = 'Qm9-unshaped-provider-credential-7731'
const GITHUB_JWT_TOKEN = `ghs_${'B'.repeat(36)}.eyJpc3MiOiJnaXRodWJfYXBwXzEyMyJ9.c2lnbmF0dXJlX2J5dGVzX2Rldl8xMjM0`
const PAIRING = 'orca://pair?code=eyJ2IjoxLCJrIjoic2VjcmV0LXBhaXJpbmcta2V5In0'
const GATEWAY = 'vck_7GkQ2mXzP9rT4wN8yB1cV6hJ3sL0dF5a'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('crash report sanitizer', () => {
  it('strips registered stored-key values, token shapes, pairing codes and env assignments', () => {
    registerRedactedSecretValue(STORED_KEY)
    const text = [
      `spawn failed: ${STORED_KEY}`,
      `git: ${GITHUB_JWT_TOKEN}`,
      `pair ${PAIRING}`,
      `gateway ${GATEWAY}`,
      'ANTHROPIC_API_KEY=plainvalue1234 OPENAI_BASE_URL=https://x.example'
    ].join(' | ')
    const out = sanitizeCrashReportString(text, 4_000)
    for (const leaked of [
      STORED_KEY,
      GITHUB_JWT_TOKEN.split('.')[1]!,
      GITHUB_JWT_TOKEN.split('.')[2]!,
      'secret-pairing',
      PAIRING.split('=')[1]!,
      GATEWAY,
      'plainvalue1234'
    ]) {
      expect(out).not.toContain(leaked)
    }
    expect(out).toContain('ANTHROPIC_API_KEY=[redacted]')
    // Non-credential config survives so the report stays useful.
    expect(out).toContain('OPENAI_BASE_URL=')
  })

  it('applies to structured crash details and breadcrumbs', () => {
    registerRedactedSecretValue(STORED_KEY)
    const out = sanitizeCrashReportDetails({ error_stack: `Error: bad key ${STORED_KEY}\n  at x` })
    expect(String(out.error_stack)).not.toContain(STORED_KEY)
  })
})

describe('daemon file log', () => {
  it('never writes injected credentials to disk', async () => {
    registerRedactedSecretValue(STORED_KEY)
    const dir = mkdtempSync(join(tmpdir(), 'orca-daemon-log-'))
    try {
      const file = join(dir, 'daemon.log')
      const log = createDaemonFileLog(file)
      log.log('spawn-failed', {
        message: `exec failed with ${STORED_KEY} and ${GITHUB_JWT_TOKEN}`,
        env: { ANTHROPIC_API_KEY: STORED_KEY },
        sessionId: 's-1'
      })
      log.close()
      await vi.waitFor(() => expect(readFileSync(file, 'utf8')).toContain('daemon-log-closed'))
      const written = readFileSync(file, 'utf8')
      expect(written).toContain('s-1')
      expect(written).not.toContain(STORED_KEY)
      expect(written).not.toContain(GITHUB_JWT_TOKEN.split('.')[2]!)
      expect(written).not.toContain('"env"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('relayed worker spans', () => {
  it('are redacted again in main, where stored-key values are known', async () => {
    const { recordRelayedSpan, setActiveSink } = await import('./tracer')
    const { registerRedactedSecretValue: register } = await import('./redactor')
    register(STORED_KEY)
    const pushed: unknown[] = []
    setActiveSink({ push: (record) => pushed.push(record), flush() {}, close() {} })
    try {
      recordRelayedSpan({
        type: 'effect-span',
        name: 'search',
        attributes: { query: `find ${STORED_KEY}` },
        exit: { _tag: 'Failure', cause: `boom ${STORED_KEY}` }
      })
    } finally {
      setActiveSink(null)
    }
    const text = JSON.stringify(pushed)
    expect(text).toContain('search')
    expect(text).not.toContain(STORED_KEY)
  })
})

describe('emulator probe', () => {
  it('redacts RPC params (launch env, pairing codes) before logging them', async () => {
    vi.stubEnv('ORCA_EMULATOR_PROBE', '1')
    const { emulatorProbe } = await import('../emulator/emulator-probe')
    const { registerRedactedSecretValue: register } = await import('./redactor')
    register(STORED_KEY)
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line)
    })
    try {
      emulatorProbe('rpc terminal.createAgentSession', {
        agent: 'claude',
        keyEnv: { ANTHROPIC_API_KEY: STORED_KEY },
        env: { CUSTOM: STORED_KEY },
        note: `pairing ${PAIRING} and ${STORED_KEY}`
      })
    } finally {
      spy.mockRestore()
    }
    const text = lines.join('\n')
    expect(text).toContain('claude')
    expect(text).not.toContain(STORED_KEY)
    expect(text).not.toContain(PAIRING)
  })
})
