import { expect, vi } from 'vitest'
import type { WslResult, WslSpec } from '../wsl/wsl-runner'

export function wslOk(stdout = ''): WslResult {
  return { environmentResolved: true, code: 0, stdout, stderr: '', timedOut: false }
}

export function wslFailed(code: number, stderr = ''): WslResult {
  return { environmentResolved: true, code, stdout: '', stderr, timedOut: false }
}

/** Answers the managed-home ownership check (a fenced `readlink` script) with `answer`; passes other scripts on. */
export function withOwnershipCheck(
  answer: (distro: string, script: string) => string,
  rest: (spec: WslSpec) => Promise<WslResult>
) {
  return vi.fn(async (spec: WslSpec) => {
    const script = String(spec.script)
    const begin = /printf %s (__ORCA_WSL_CAPTURE_BEGIN_) (\S+__)/.exec(script)
    const end = /printf %s (__ORCA_WSL_CAPTURE_END_) (\S+__)/.exec(script)
    if (!begin || !end || !script.includes('readlink -f')) {
      return rest(spec)
    }
    expect(spec.loginPath).toBe('none')
    const payload = answer(String(spec.distro), script)
    return wslOk(`${begin[1]}${begin[2]}${payload}\n${end[1]}${end[2]}`)
  })
}
