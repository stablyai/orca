import { describe, expect, it } from 'vitest'
import { ensureHarmonyOk } from './harmony-command-result'
import type { HarmonyCommandResult } from './harmony-command-runner'

const ok: HarmonyCommandResult = { stdout: 'done', stderr: '', code: 0 }

describe('ensureHarmonyOk', () => {
  it('passes the result through on exit 0', () => {
    expect(ensureHarmonyOk(ok, 'hdc x')).toBe(ok)
  })

  it('throws with stderr on non-zero', () => {
    const fail: HarmonyCommandResult = { stdout: '', stderr: 'offline', code: 1 }
    expect(() => ensureHarmonyOk(fail, 'hdc tap')).toThrow(
      expect.objectContaining({
        code: 'emulator_error',
        message: 'hdc tap failed: offline'
      })
    )
  })

  it('falls back to stdout when stderr is empty', () => {
    const fail: HarmonyCommandResult = { stdout: 'not found', stderr: '', code: 1 }
    expect(() => ensureHarmonyOk(fail, 'hdc x')).toThrow('hdc x failed: not found')
  })
})
