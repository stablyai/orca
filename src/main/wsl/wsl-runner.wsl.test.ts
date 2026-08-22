import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runWslProcess } from './wsl-runner'
import { invalidateWslGuestEnvironment } from './wsl-guest-environment'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveWslExecutablePath } from './wsl-executable-path'

/**
 * The assertions no unit test can make: a real distro, a real login shell, a
 * real rc banner.
 *
 * Gated behind an env var and win32 because it mutates the distro's `~/.profile`
 * to reproduce #14288. Run with:
 *   ORCA_REAL_WSL_RUNNER_TEST=1 pnpm vitest run src/main/wsl/wsl-runner.wsl.test.ts
 */
const DISTRO = process.env.ORCA_WSL_TEST_DISTRO ?? 'Ubuntu-24.04'
const enabled = process.platform === 'win32' && process.env.ORCA_REAL_WSL_RUNNER_TEST === '1'
const describeOnWsl = enabled ? describe : describe.skip

const PROFILE = '/tmp/orca-wsl-runner-profile.bak'

async function guest(script: string): Promise<string> {
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: ['-d', DISTRO, '--exec', 'sh', '-c', script],
    timeoutMs: 30_000
  })
  return result.stdout.trim()
}

describeOnWsl('runWslProcess against a real distro', () => {
  beforeAll(async () => {
    // Save whatever profile exists, then make it block for far longer than the
    // probe budget -- this is #14288 reproduced, not simulated.
    await guest(`cp -f "$HOME/.profile" ${PROFILE} 2>/dev/null || true`)
    await guest(`printf '\\nsleep 60\\n' >> "$HOME/.profile"`)
    invalidateWslGuestEnvironment(undefined, true)
  }, 120_000)

  afterAll(async () => {
    await guest(`cp -f ${PROFILE} "$HOME/.profile" 2>/dev/null || rm -f "$HOME/.profile"`)
    await guest(`rm -f ${PROFILE}`)
    invalidateWslGuestEnvironment(undefined, true)
  }, 120_000)

  it('probe lane survives a ~/.profile that blocks for a minute', async () => {
    // The blocking profile makes the probe time out, so the lane degrades --
    // that is the point: the call must still answer inside its own budget
    // rather than inheriting the 60s stall. This is #14288 against a real
    // distro, and it needs allowDegradedEnvironment because the runner
    // otherwise refuses an unresolved PATH.
    const started = Date.now()
    const result = await runWslProcess({
      lane: 'probe',
      distro: DISTRO,
      allowDegradedEnvironment: true,
      program: '/bin/echo',
      args: ['orca-probe-ok'],
      timeoutMs: 15_000
    })
    const elapsed = Date.now() - started
    expect(result.stdout.trim()).toContain('orca-probe-ok')
    expect(elapsed).toBeLessThan(20_000)
  }, 60_000)

  it('second probe-lane call does not pay the login shell again', async () => {
    const started = Date.now()
    await runWslProcess({
      lane: 'probe',
      distro: DISTRO,
      program: '/bin/true',
      timeoutMs: 15_000,
      allowDegradedEnvironment: true
    })
    expect(Date.now() - started).toBeLessThan(5_000)
  }, 30_000)

  it('interactive lane strips the distro banner from parsed stdout', async () => {
    // Stock Ubuntu writes its rc hint to stdout. Anything parsing that stream
    // reads the banner as data unless the fence removes it (#11327, #11823).
    const result = await runWslProcess({
      lane: 'interactive',
      distro: DISTRO,
      program: '/bin/echo',
      args: ['ORCA_PAYLOAD'],
      timeoutMs: 60_000
    })
    expect(result.stdout.trim()).toBe('ORCA_PAYLOAD')
  }, 90_000)

  it('a script with quotes and $ arrives byte-identical', async () => {
    // Both hazards in one payload: `--` would expand $2 host-side, and the
    // base64/eval wrappers broke on the embedded quotes (#12964, #14292).
    const script = [
      `printf '%s\\n' "$1"`,
      `echo 'it'\\''s fine'`,
      `echo "x" | awk '{print $1}'`
    ].join('\n')
    const result = await runWslProcess({
      lane: 'probe',
      distro: DISTRO,
      allowDegradedEnvironment: true,
      script,
      args: ['ORCA_ARG'],
      timeoutMs: 30_000
    })
    expect(
      result.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    ).toEqual(['ORCA_ARG', "it's fine", 'x'])
  }, 60_000)

  it('propagated env crosses the boundary via WSLENV', async () => {
    const result = await runWslProcess({
      lane: 'probe',
      distro: DISTRO,
      allowDegradedEnvironment: true,
      script: 'printf %s "$ORCA_WSLENV_PROBE"',
      env: { ORCA_WSLENV_PROBE: 'crossed' },
      timeoutMs: 30_000
    })
    expect(result.stdout.trim()).toBe('crossed')
  }, 60_000)

  it('runs in the requested guest cwd', async () => {
    const result = await runWslProcess({
      lane: 'probe',
      distro: DISTRO,
      allowDegradedEnvironment: true,
      program: '/bin/pwd',
      cwd: '/tmp',
      timeoutMs: 30_000
    })
    expect(result.stdout.trim()).toBe('/tmp')
  }, 60_000)
})
