import { describe, expect, it } from 'vitest'
import type { PtySpawnOptions } from './types'
import { buildSshPtySpawnRequest } from './ssh-pty-spawn-request'

// Why this test exists: the incognito ("no-session") flag suppresses the shell's on-disk command
// history, but that suppression lives on the remote relay. If this payload builder drops the flag,
// the relay never learns the terminal is incognito and records history on the execution host — the
// exact leak this fixes. Behavioral, not a source grep: it asserts the wire payload, which is what
// the relay actually reads.
describe('buildSshPtySpawnRequest incognito', () => {
  const baseOptions = (overrides: Partial<PtySpawnOptions> = {}): PtySpawnOptions =>
    ({ cols: 80, rows: 24, cwd: '/remote/wt', ...overrides }) as PtySpawnOptions

  it('carries incognito=true into the main→remote spawn payload', () => {
    const params = buildSshPtySpawnRequest({
      options: baseOptions({ incognito: true }),
      supportsCreateOperation: false
    })
    expect(params.incognito).toBe(true)
  })

  it('omits incognito when the terminal is not incognito', () => {
    for (const incognito of [false, undefined] as const) {
      const params = buildSshPtySpawnRequest({
        options: baseOptions({ incognito }),
        supportsCreateOperation: false
      })
      expect('incognito' in params).toBe(false)
    }
  })
})
