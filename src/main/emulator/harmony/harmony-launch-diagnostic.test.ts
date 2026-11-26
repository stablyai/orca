import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  launchDiagnosticPath,
  writeHarmonyLaunchDiagnostic,
  type HarmonyLaunchFailure
} from './harmony-launch-diagnostic'

const written: string[] = []
const at = new Date('2026-11-26T09:30:05.123Z')

function failure(overrides: Partial<HarmonyLaunchFailure> = {}): HarmonyLaunchFailure {
  return {
    instanceName: 'Mate 90 Pro',
    argv: ['-start', 'Mate 90 Pro', '-hdcPort', '10000'],
    reason: 'exited before the hdc target connected',
    code: 1,
    signal: null,
    stdout: '',
    stderr: 'Emulator: GLib: g_hash_table_lookup failed',
    ...overrides
  }
}

afterEach(() => {
  for (const path of written.splice(0)) {
    rmSync(path, { force: true })
  }
})

describe('writeHarmonyLaunchDiagnostic', () => {
  it('writes a timestamped file named after the sanitized instance', () => {
    const path = writeHarmonyLaunchDiagnostic(failure(), at)
    const expected = join(tmpdir(), 'orca-harmony-launch-Mate-90-Pro-2026-11-26T09-30-05-123Z.log')
    expect(path).toBe(expected)
    if (!path) {
      throw new Error('expected a diagnostic file path')
    }
    written.push(path)

    const recorded = launchDiagnosticPath('Mate 90 Pro', at)
    expect(recorded).toBe(path)
  })

  it('records the argv, reason and emulator stderr in the file body', () => {
    const path = writeHarmonyLaunchDiagnostic(
      failure({ diagnostics: 'emulator reports isRunning=false; hdc sees no targets visible' }),
      at
    )
    if (!path) {
      throw new Error('expected a diagnostic file path')
    }
    written.push(path)
    const body = readFileSync(path, 'utf8')
    expect(body).toContain('argv: -start Mate 90 Pro -hdcPort 10000')
    expect(body).toContain('reason: exited before the hdc target connected')
    expect(body).toContain('Emulator: GLib: g_hash_table_lookup failed')
    expect(body).toContain('hdc sees no targets visible')
  })

  it('never throws on a bad clock and still returns null', () => {
    expect(writeHarmonyLaunchDiagnostic(failure(), new Date('not a date'))).toBeNull()
  })
})
