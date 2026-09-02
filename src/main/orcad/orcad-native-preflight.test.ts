import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ORCAD_NATIVE_PRECONDITION_EXIT_CODE,
  runOrcadNativePreflight
} from './orcad-native-preflight'
import {
  runtimeTerminalDegradation,
  setRuntimeTerminalUnavailableCause
} from '../runtime/native-terminal-availability'
import type { NodePtyPreconditionVerdict } from './node-pty-precondition'

const ABI = {
  platform: 'linux' as NodeJS.Platform,
  arch: 'x64',
  libc: 'glibc' as const,
  glibcVersion: '2.31',
  nodeAbi: '127'
}

const verdict = (over: Partial<NodePtyPreconditionVerdict>): NodePtyPreconditionVerdict => ({
  status: 'ok',
  slot: 'linux-x64-glibc',
  abi: ABI,
  ...over
})

const harness = (given: NodePtyPreconditionVerdict) => {
  const warn = vi.fn()
  const fail = vi.fn()
  const exit = vi.fn(() => undefined as never)
  const continued = runOrcadNativePreflight({
    check: () => given,
    toolchainHints: () => ['  sudo apt-get install -y build-essential python3'],
    warn,
    fail,
    exit
  })
  return { warn, fail, exit, continued }
}

afterEach(() => {
  setRuntimeTerminalUnavailableCause(null)
})

describe('runOrcadNativePreflight', () => {
  it('stops the boot on a proven-unloadable binary instead of reaching the require', () => {
    // Continuing here would hit the very dlopen the probe just proved fatal, and the
    // operator would get the loader's stack trace instead of the sentence below.
    const { fail, exit, warn } = harness(
      verdict({ status: 'blocked', reason: 'libc_floor', detail: 'the binary requires GLIBC_2.34' })
    )

    expect(exit).toHaveBeenCalledWith(ORCAD_NATIVE_PRECONDITION_EXIT_CODE)
    expect(warn).not.toHaveBeenCalled()
    const message = fail.mock.calls[0][0] as string
    expect(message).toContain('newer C library')
    expect(message).toContain('the binary requires GLIBC_2.34')
    expect(message).toContain('libc glibc 2.31')
    // The toolchain hint is what makes it actionable rather than merely accurate.
    expect(message).toContain('sudo apt-get install -y build-essential python3')
  })

  it('exits with EX_CONFIG so a supervisor does not restart an unequippable host forever', () => {
    expect(ORCAD_NATIVE_PRECONDITION_EXIT_CODE).toBe(78)
    expect(ORCAD_NATIVE_PRECONDITION_EXIT_CODE).not.toBe(1)
  })

  it('publishes the blocked cause as a status degradation', () => {
    harness(verdict({ status: 'blocked', reason: 'abi_mismatch', detail: 'built for ABI 115' }))

    expect(runtimeTerminalDegradation()).toEqual({
      code: 'terminal_unavailable',
      capability: 'terminal.pty.v1',
      reason: 'abi_mismatch',
      detail: 'built for ABI 115',
      message:
        "This host's node-pty binary was built for a different Node ABI than the running Node, so it cannot be loaded. Rebuild node-pty against this Node version. (built for ABI 115)"
    })
  })

  it('boots on a spawn-time-only fault and reports it rather than refusing to serve', () => {
    const { continued, exit, warn } = harness(
      verdict({ status: 'degraded', reason: 'spawn_helper_missing', detail: 'no spawn-helper' })
    )

    expect(continued).toBe(true)
    expect(exit).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(runtimeTerminalDegradation()?.reason).toBe('spawn_helper_missing')
  })

  it('boots when the probe established nothing, because that is not evidence of a fault', () => {
    const { continued, exit } = harness(
      verdict({ status: 'unverifiable', reason: 'unknown', detail: 'probe timed out' })
    )

    expect(continued).toBe(true)
    expect(exit).not.toHaveBeenCalled()
    // Still reported: an unverifiable host must not look identical to a proven-healthy one.
    expect(runtimeTerminalDegradation()?.reason).toBe('unknown')
  })

  it('reports nothing when the load was proved good', () => {
    setRuntimeTerminalUnavailableCause({ reason: 'load_failed' })

    const { continued, warn, fail } = harness(verdict({ status: 'ok' }))

    expect(continued).toBe(true)
    expect(warn).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
    expect(runtimeTerminalDegradation()).toBeNull()
  })

  it('does not run the toolchain probe for a verdict that is not about a missing build', () => {
    const toolchainHints = vi.fn(() => [] as string[])
    runOrcadNativePreflight({
      check: () => verdict({ status: 'degraded', reason: 'spawn_helper_missing' }),
      toolchainHints,
      warn: vi.fn(),
      fail: vi.fn(),
      exit: vi.fn(() => undefined as never)
    })
    expect(toolchainHints).not.toHaveBeenCalled()
  })
})
