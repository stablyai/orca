import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ProcessResult } from '@orca/process-host/process-spec'
import {
  ensureMacPressAndHoldDefault,
  interpretDefaultsRead,
  isOrcaPreferencesDomain,
  readBundleIdentifierFromExecutablePath,
  type PressAndHoldDecision,
  type PressAndHoldHost,
  type PressAndHoldRecord
} from './macos-press-and-hold-default'

const ORCA_DOMAIN = 'com.stablyai.orca'

type HostOverrides = Partial<PressAndHoldHost> & { record?: PressAndHoldRecord | null }

function createHost(overrides: HostOverrides = {}): {
  host: PressAndHoldHost
  writes: { domain: string; value: boolean }[]
  records: PressAndHoldRecord[]
} {
  const writes: { domain: string; value: boolean }[] = []
  const records: PressAndHoldRecord[] = []
  let stored = overrides.record ?? null
  const host: PressAndHoldHost = {
    platform: 'darwin',
    resolveBundleIdentifier: () => ORCA_DOMAIN,
    readRecord: () => stored,
    writeRecord: (record) => {
      stored = record
      records.push(record)
    },
    readDomainPreference: () => 'unset',
    writeDomainPreference: (domain, value) => {
      writes.push({ domain, value })
      return true
    },
    now: () => '2026-08-20T00:00:00.000Z',
    ...overrides
  }
  return { host, writes, records }
}

function terminalRecord(decision: PressAndHoldDecision): PressAndHoldRecord {
  return { version: 1, decision, domain: ORCA_DOMAIN, decidedAt: '2026-01-01T00:00:00.000Z' }
}

describe('ensureMacPressAndHoldDefault', () => {
  it('writes the opt-out when the domain has no explicit value', () => {
    const { host, writes, records } = createHost()

    expect(ensureMacPressAndHoldDefault(host)).toBe('applied')
    expect(writes).toEqual([{ domain: ORCA_DOMAIN, value: false }])
    expect(records.at(-1)?.decision).toBe('applied')
  })

  describe('platform guard', () => {
    for (const platform of ['win32', 'linux'] as const) {
      it(`does nothing at all on ${platform}`, () => {
        const probe = vi.fn(() => 'unset' as const)
        const readRecord = vi.fn(() => null)
        const { host, writes, records } = createHost({
          platform,
          readDomainPreference: probe,
          readRecord
        })

        expect(ensureMacPressAndHoldDefault(host)).toBe('not-macos')
        expect(probe).not.toHaveBeenCalled()
        expect(readRecord).not.toHaveBeenCalled()
        expect(writes).toEqual([])
        expect(records).toEqual([])
      })
    }
  })

  describe('respects an explicit user setting', () => {
    it('leaves the domain alone when the user already set a value', () => {
      // The real-binary suite verifies that both true and false report set.
      const { host, writes, records } = createHost({ readDomainPreference: () => 'set' })

      expect(ensureMacPressAndHoldDefault(host)).toBe('kept-user-preference')
      expect(writes).toEqual([])
      expect(records.at(-1)?.decision).toBe('kept-user-preference')
    })

    it('never re-applies after a launch already decided', () => {
      for (const decision of ['applied', 'kept-user-preference'] as const) {
        const probe = vi.fn(() => 'unset' as const)
        const { host, writes } = createHost({
          record: terminalRecord(decision),
          readDomainPreference: probe
        })

        expect(ensureMacPressAndHoldDefault(host)).toBe('already-decided')
        expect(probe).not.toHaveBeenCalled()
        expect(writes).toEqual([])
      }
    })

    it('stays out of the way after the user deletes the key we wrote', () => {
      // Deleting the preference restores the accent picker; the recorded decision must prevent rewriting it.
      const { host, writes } = createHost({
        record: terminalRecord('applied'),
        readDomainPreference: () => 'unset'
      })

      expect(ensureMacPressAndHoldDefault(host)).toBe('already-decided')
      expect(writes).toEqual([])
    })
  })

  describe('domains we do not own', () => {
    it('skips a bare Electron bundle rather than writing into a shared domain', () => {
      const probe = vi.fn(() => 'unset' as const)
      const { host, writes, records } = createHost({
        resolveBundleIdentifier: () => 'com.github.Electron',
        readDomainPreference: probe
      })

      expect(ensureMacPressAndHoldDefault(host)).toBe('foreign-bundle')
      expect(probe).not.toHaveBeenCalled()
      expect(writes).toEqual([])
      expect(records.at(-1)?.domain).toBe('com.github.Electron')
    })

    it('skips when the bundle identifier cannot be resolved', () => {
      const { host, writes } = createHost({ resolveBundleIdentifier: () => null })

      expect(ensureMacPressAndHoldDefault(host)).toBe('foreign-bundle')
      expect(writes).toEqual([])
    })

    it('accepts Orca and its channel-scoped bundles, and nothing else', () => {
      expect(isOrcaPreferencesDomain('com.stablyai.orca')).toBe(true)
      expect(isOrcaPreferencesDomain('com.stablyai.orca.dev')).toBe(true)
      expect(isOrcaPreferencesDomain('com.github.Electron')).toBe(false)
      expect(isOrcaPreferencesDomain('com.stablyai.orcafake')).toBe(false)
    })
  })

  describe('failures leave the decision open', () => {
    it('does not write when the probe cannot tell unset from user-set', () => {
      const { host, writes, records } = createHost({ readDomainPreference: () => 'unknown' })

      expect(ensureMacPressAndHoldDefault(host)).toBe('probe-failed')
      expect(writes).toEqual([])
      expect(records.at(-1)?.decision).toBe('probe-failed')
    })

    it('retries on the next launch after a failed write', () => {
      const { host, records } = createHost({ writeDomainPreference: () => false })
      expect(ensureMacPressAndHoldDefault(host)).toBe('write-failed')

      const retry = createHost({ record: records.at(-1) })
      expect(ensureMacPressAndHoldDefault(retry.host)).toBe('applied')
      expect(retry.writes).toEqual([{ domain: ORCA_DOMAIN, value: false }])
    })
  })

  it('does not rewrite an unchanged non-terminal record', () => {
    const first = createHost({ resolveBundleIdentifier: () => 'com.github.Electron' })
    expect(ensureMacPressAndHoldDefault(first.host)).toBe('foreign-bundle')

    const second = createHost({
      record: first.records.at(-1),
      resolveBundleIdentifier: () => 'com.github.Electron'
    })
    expect(ensureMacPressAndHoldDefault(second.host)).toBe('foreign-bundle')
    expect(second.records).toEqual([])
  })
})

describe('interpretDefaultsRead', () => {
  function probe(overrides: Partial<ProcessResult>): () => ProcessResult {
    return () => ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides })
  }

  it('reads a clean exit as an explicit value', () => {
    expect(interpretDefaultsRead(probe({ code: 0 }))).toBe('set')
  })

  it('reads only "does not exist" as unset', () => {
    expect(interpretDefaultsRead(probe({ code: 1 }))).toBe('unset')
  })

  describe('refuses to call a failed probe unset', () => {
    const failures: [string, () => ProcessResult][] = [
      ['killed before it exited', probe({ code: null, signal: 'SIGTERM' })],
      ['timed out', probe({ code: null, timedOut: true })],
      [
        'timed out after somehow reporting the missing-key code',
        probe({ code: 1, timedOut: true })
      ],
      ['exited with some other error', probe({ code: 2 })],
      ['exited with a negative status', probe({ code: -1 })],
      [
        'never started at all',
        () => {
          throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
        }
      ]
    ]
    for (const [name, failing] of failures) {
      it(name, () => {
        expect(interpretDefaultsRead(failing)).toBe('unknown')
      })
    }
  })
})

describe('readBundleIdentifierFromExecutablePath', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function bundleWithPlist(body: string): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-press-hold-'))
    roots.push(root)
    mkdirSync(join(root, 'Orca.app', 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(root, 'Orca.app', 'Contents', 'Info.plist'), body)
    return join(root, 'Orca.app', 'Contents', 'MacOS', 'Orca')
  }

  it('reads CFBundleIdentifier from the plist beside the executable', () => {
    const exe = bundleWithPlist(
      '<plist><dict>\n<key>CFBundleName</key>\n<string>Orca</string>\n' +
        '<key>CFBundleIdentifier</key>\n\t<string>com.stablyai.orca</string>\n</dict></plist>'
    )

    expect(readBundleIdentifierFromExecutablePath(exe)).toBe('com.stablyai.orca')
  })

  it('returns null when the plist is missing or carries no identifier', () => {
    expect(readBundleIdentifierFromExecutablePath('/nonexistent/App.app/Contents/MacOS/App')).toBe(
      null
    )
    expect(readBundleIdentifierFromExecutablePath(bundleWithPlist('<plist><dict/></plist>'))).toBe(
      null
    )
    expect(
      readBundleIdentifierFromExecutablePath(
        bundleWithPlist('<key>CFBundleIdentifier</key><string></string>')
      )
    ).toBe(null)
  })
})

describe('startup wiring', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
    'utf8'
  )
  const entrySource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('runs before app.whenReady(), which is the last point AppKit could still see it', () => {
    const callIndex = source.indexOf(
      'applyMacPressAndHoldDefaultAtStartup(getCanonicalUserDataPath())'
    )
    const initDataPathIndex = source.indexOf('initDataPath()')
    const readyIndex = entrySource.indexOf('void app.whenReady().then(async () => {')
    const preflightCall = entrySource.indexOf('runMainProcessPreflight({')

    expect(callIndex).toBeGreaterThanOrEqual(0)
    expect(readyIndex).toBeGreaterThanOrEqual(0)
    expect(preflightCall).toBeGreaterThanOrEqual(0)
    // initDataPath captures the canonical userData path where the decision record belongs.
    expect(callIndex).toBeGreaterThan(initDataPathIndex)
    expect(preflightCall).toBeLessThan(readyIndex)
  })
})
