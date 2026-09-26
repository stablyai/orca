import { describe, expect, it } from 'vitest'
import { resolveBindPortCandidates } from './ws-bind-port-candidates'

describe('resolveBindPortCandidates', () => {
  const resolve = (options: {
    port: number
    fallbackPort?: number
    preferPinnedPort?: boolean
    allowOsAssignedPortFallback?: boolean
  }) =>
    resolveBindPortCandidates({
      port: options.port,
      fallbackPort: options.fallbackPort,
      preferPinnedPort: options.preferPinnedPort === true,
      allowOsAssignedPortFallback: options.allowOsAssignedPortFallback !== false
    }).map((candidate) => candidate.port)

  it('binds a persisted fallback before the configured port (STA-1511)', () => {
    expect(resolve({ port: 6768, fallbackPort: 51234 })).toEqual([51234, 6768, 0])
  })

  it('binds the pin first when preferPinnedPort is set (issue #8535)', () => {
    expect(resolve({ port: 6768, fallbackPort: 51234, preferPinnedPort: true })).toEqual([
      6768, 51234, 0
    ])
  })

  it('ignores a fallback that is absent, zero, or equal to the configured port', () => {
    expect(resolve({ port: 6768 })).toEqual([6768, 0])
    expect(resolve({ port: 6768, fallbackPort: 0 })).toEqual([6768, 0])
    expect(resolve({ port: 6768, fallbackPort: 6768 })).toEqual([6768, 0])
  })

  // Why: STA-7721 — the whole fix. Without this, a rebind that loses its port relocates to whatever the OS
  // hands out, which reports success while nothing serves the endpoint already published to devices.
  it('omits the OS-assigned port when relocation is disallowed', () => {
    expect(resolve({ port: 6768, allowOsAssignedPortFallback: false })).toEqual([6768])
    expect(
      resolve({ port: 6768, fallbackPort: 51234, allowOsAssignedPortFallback: false })
    ).toEqual([51234, 6768])
  })

  it('never lists the OS-assigned port twice when the configured port is already 0', () => {
    expect(resolve({ port: 0 })).toEqual([0])
  })

  // Why: only a persisted fallback is a guess from a previous launch, so only it may be abandoned on any
  // error; a configured port that fails for an unexpected reason must surface that reason.
  it('tolerates any error only on the persisted fallback', () => {
    expect(
      resolveBindPortCandidates({
        port: 6768,
        fallbackPort: 51234,
        preferPinnedPort: false,
        allowOsAssignedPortFallback: true
      })
    ).toEqual([
      { port: 51234, tolerateAnyError: true },
      { port: 6768, tolerateAnyError: false },
      { port: 0, tolerateAnyError: false }
    ])
  })
})
