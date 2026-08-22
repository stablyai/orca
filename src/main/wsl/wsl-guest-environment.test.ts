import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: runProcessMock }))
vi.mock('./wsl-executable-path', () => ({ resolveWslExecutablePath: () => 'wsl.exe' }))

import {
  getWslGuestEnvironment,
  invalidateWslGuestEnvironment,
  peekWslGuestEnvironment
} from './wsl-guest-environment'

/** Echo a well-formed payload back inside whatever fence the probe generated. */
function respondWithPayload(payload: string, code = 0): void {
  runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
    const script = spec.args.at(-1) ?? ''
    const begin = /__ORCA_WSL_CAPTURE_BEGIN_[a-z0-9]+__/.exec(script)?.[0] ?? ''
    const end = /__ORCA_WSL_CAPTURE_END_[a-z0-9]+__/.exec(script)?.[0] ?? ''
    return {
      code,
      signal: null,
      stdout: `distro banner\n${begin}${payload}${end}`,
      stderr: '',
      timedOut: false
    }
  })
}

const GOOD = ['/home/u/.nvm/bin:/usr/bin', '/home/u', '/usr/bin/env'].join('\0')

beforeEach(() => {
  runProcessMock.mockReset()
  invalidateWslGuestEnvironment(undefined, true)
})
afterEach(() => invalidateWslGuestEnvironment(undefined, true))

describe('probing', () => {
  it('reads PATH, HOME and env out of a banner-polluted stdout', async () => {
    respondWithPayload(GOOD)
    expect(await getWslGuestEnvironment('Ubuntu')).toEqual({
      path: '/home/u/.nvm/bin:/usr/bin',
      home: '/home/u',
      envBinary: '/usr/bin/env'
    })
  })

  it('collapses a concurrent burst into one probe', async () => {
    // Teardown and detection both fan out; 32 login shells per burst is the
    // cost this cache exists to avoid.
    respondWithPayload(GOOD)
    await Promise.all(Array.from({ length: 32 }, () => getWslGuestEnvironment('Ubuntu')))
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('keeps distros isolated', async () => {
    respondWithPayload(GOOD)
    await getWslGuestEnvironment('Ubuntu')
    await getWslGuestEnvironment('Debian')
    expect(runProcessMock).toHaveBeenCalledTimes(2)
  })
})

describe('bad answers are not cached as good ones', () => {
  it.each([
    ['a relative HOME', ['/usr/bin', 'home/u', '/usr/bin/env'].join('\0')],
    ['a PATH with a newline', ['/usr/bin\nx', '/home/u', '/usr/bin/env'].join('\0')],
    ['a truncated payload', '/usr/bin'],
    ['a relative env binary', ['/usr/bin', '/home/u', 'env'].join('\0')]
  ])('rejects %s', async (_case, payload) => {
    respondWithPayload(payload)
    expect(await getWslGuestEnvironment('Ubuntu')).toBeNull()
    expect(peekWslGuestEnvironment('Ubuntu')).toBeUndefined()
  })

  it('treats a missing fence as a failed probe, not an empty PATH', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: 'only a banner, no fence',
      stderr: '',
      timedOut: false
    })
    expect(await getWslGuestEnvironment('Ubuntu')).toBeNull()
  })
})

describe('transient versus permanent failure', () => {
  it('does not retry a distro that cannot produce env', async () => {
    // 127 is the probe's own "no usable env". Retrying that forever turns a
    // probe into a poller.
    runProcessMock.mockResolvedValue({
      code: 127,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    await getWslGuestEnvironment('Ubuntu')
    await getWslGuestEnvironment('Ubuntu')
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('retries after the window when the probe timed out', async () => {
    vi.useFakeTimers()
    try {
      runProcessMock.mockResolvedValue({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: true
      })
      expect(await getWslGuestEnvironment('Ubuntu')).toBeNull()
      expect(await getWslGuestEnvironment('Ubuntu')).toBeNull()
      // Still one probe inside the window: the retry timer gates it now that
      // the in-flight entry is dropped.
      expect(runProcessMock).toHaveBeenCalledTimes(1)

      vi.setSystemTime(Date.now() + 6_000)
      respondWithPayload(GOOD)
      expect(await getWslGuestEnvironment('Ubuntu')).not.toBeNull()
      expect(runProcessMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('a failed verdict does not outlive its usefulness', () => {
  it('retries an unparseable payload rather than caching it forever', async () => {
    // Before: any unparseable payload was permanent, so one fence lost to a
    // truncated rc disabled every WSL feature on the distro until restart.
    vi.useFakeTimers()
    try {
      respondWithPayload('garbage')
      expect(await getWslGuestEnvironment('Ubuntu')).toBeNull()
      vi.setSystemTime(Date.now() + 6_000)
      respondWithPayload(GOOD)
      expect(await getWslGuestEnvironment('Ubuntu')).not.toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a caller with more budget re-probe past a starved failure', async () => {
    // An optional 5s read must not hard-fail the 10s scan queued behind it.
    runProcessMock.mockResolvedValue({
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: true
    })
    expect(await getWslGuestEnvironment('Ubuntu', 3_000)).toBeNull()
    respondWithPayload(GOOD)
    expect(await getWslGuestEnvironment('Ubuntu', 9_000)).not.toBeNull()
  })

  it('bounds a joiner by its own budget, not the starter\'s', async () => {
    // Joining used to mean waiting out the starter's probe, so a joiner could
    // reach its own command with 1ms left.
    let release: (v: unknown) => void = () => {}
    runProcessMock.mockImplementation(() => new Promise((r) => (release = r)))
    const slow = getWslGuestEnvironment('Ubuntu', 60_000)
    const joiner = getWslGuestEnvironment('Ubuntu', 30)
    expect(await joiner).toBeNull()
    release({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false })
    await slow
  })
})

describe('invalidation', () => {
  it('re-probes after the caller invalidates, so a newly installed tool appears', async () => {
    // A user who installs nvm inside a running distro would otherwise keep the
    // pre-install PATH until Orca restarts, and read that as the detection bug
    // this cache exists to fix.
    respondWithPayload(GOOD)
    await getWslGuestEnvironment('Ubuntu')
    invalidateWslGuestEnvironment('Ubuntu')
    respondWithPayload(['/opt/new/bin', '/home/u', '/usr/bin/env'].join('\0'))
    expect((await getWslGuestEnvironment('Ubuntu'))?.path).toBe('/opt/new/bin')
  })
})
