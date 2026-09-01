import { describe, expect, it } from 'vitest'

import {
  describeRelayPtyJobControlSupport,
  readRelayPtyJobControlSupport,
  relayPtyJobControlProbeJs,
  RELAY_PTY_JOB_CONTROL_MARKER,
  type RelayPtyJobControlSupport
} from './relay-pty-job-control-capability'

// Restated rather than imported: importing the module's own list would assert it against itself.
const JOB_CONTROL_SYMBOLS = ['assignCurrentProcessToJob', 'terminateJob', 'listJobProcessIds']

/**
 * Execute the snippet the remote actually runs, the way the browser-bridge specs
 * execute their injected JS. Grepping its source pins the characters; only running
 * it pins the verdict, and the verdict is the whole contract.
 */
function runProbeSnippet(nodePtyUtils: unknown): {
  support: RelayPtyJobControlSupport
  printed: string[]
} {
  const printed: string[] = []
  const requireStub = (name: string): unknown => {
    if (name !== 'node-pty/lib/utils') {
      throw new Error(`unexpected require(${name})`)
    }
    return nodePtyUtils
  }
  new Function('require', 'console', relayPtyJobControlProbeJs('"conpty"'))(requireStub, {
    log: (line: string) => printed.push(line)
  })
  return { support: readRelayPtyJobControlSupport(printed.join('\n')), printed }
}

function utilsLoading(module: unknown): unknown {
  return { loadNativeModule: () => ({ module }) }
}

function nativeWith(symbols: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(symbols.map((symbol) => [symbol, () => true]))
}

describe('relay pty job-control capability', () => {
  it('reads a present verdict', () => {
    expect(
      readRelayPtyJobControlSupport(`ORCA-NPTY-PROBE-OK\n${RELAY_PTY_JOB_CONTROL_MARKER}present\n`)
    ).toBe('present')
  })

  it('reads an absent verdict', () => {
    expect(
      readRelayPtyJobControlSupport(`${RELAY_PTY_JOB_CONTROL_MARKER}absent\r\nORCA-NPTY-PROBE-OK\n`)
    ).toBe('absent')
  })

  it('reads a probe that could not look as unknown, not absent', () => {
    expect(
      readRelayPtyJobControlSupport(`ORCA-NPTY-PROBE-OK\n${RELAY_PTY_JOB_CONTROL_MARKER}unknown\n`)
    ).toBe('unknown')
  })

  it('reads output with no marker at all as unknown, not absent', () => {
    // An older relay, a probe that never ran, or stdout the host truncated.
    expect(readRelayPtyJobControlSupport('ORCA-NPTY-PROBE-OK\n')).toBe('unknown')
    expect(readRelayPtyJobControlSupport('')).toBe('unknown')
  })

  it('reads an unrecognised verdict as unknown, not absent', () => {
    expect(readRelayPtyJobControlSupport(`${RELAY_PTY_JOB_CONTROL_MARKER}maybe`)).toBe('unknown')
  })

  it('prints present when the remote module exposes all three job symbols', () => {
    const { support, printed } = runProbeSnippet(utilsLoading(nativeWith(JOB_CONTROL_SYMBOLS)))
    expect(support).toBe('present')
    expect(printed).toEqual([`${RELAY_PTY_JOB_CONTROL_MARKER}present`])
  })

  it('prints absent for the stock registry module', () => {
    expect(runProbeSnippet(utilsLoading(nativeWith(['spawn', 'resize']))).support).toBe('absent')
  })

  it('prints absent when only some of the three symbols are there', () => {
    // Every symbol is required: a partial module cannot terminate a tree by job object.
    expect(runProbeSnippet(utilsLoading(nativeWith(JOB_CONTROL_SYMBOLS.slice(1)))).support).toBe(
      'absent'
    )
  })

  it('prints unknown when the native load throws', () => {
    const utils = {
      loadNativeModule: () => {
        throw new Error('Failed to load native module: conpty.node')
      }
    }
    expect(runProbeSnippet(utils).support).toBe('unknown')
  })

  it('prints unknown when node-pty has no loadNativeModule to call', () => {
    // A node-pty whose internals moved is a probe that could not look, not an absence.
    expect(runProbeSnippet({}).support).toBe('unknown')
  })

  it('prints unknown, not absent, when the loader hands back no module', () => {
    expect(runProbeSnippet({ loadNativeModule: () => ({}) }).support).toBe('unknown')
    expect(runProbeSnippet(utilsLoading(null)).support).toBe('unknown')
    expect(runProbeSnippet(utilsLoading(undefined)).support).toBe('unknown')
  })

  it('names all three job symbols in the snippet it ships to the remote', () => {
    const js = relayPtyJobControlProbeJs('"conpty"')
    for (const symbol of JOB_CONTROL_SYMBOLS) {
      expect(js).toContain(symbol)
    }
  })

  it('never calls an unanswered probe an absence in the operator line', () => {
    expect(describeRelayPtyJobControlSupport('unknown')).toContain('not a confirmed absence')
    expect(describeRelayPtyJobControlSupport('unknown')).not.toContain(': absent')
    expect(describeRelayPtyJobControlSupport('absent')).toContain('absent')
    expect(describeRelayPtyJobControlSupport('present')).toContain('present')
  })
})
