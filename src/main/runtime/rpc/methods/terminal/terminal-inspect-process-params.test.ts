// The host half of the same contract: an RPC schema silently strips keys it does not declare, which
// is exactly what forward compatibility needs and exactly how a caller's option can vanish inside
// one version. `scanChildProcesses` has to be declared here, and only here -- the sibling handle
// methods have no use for it and must keep refusing it.
import { describe, expect, it, vi } from 'vitest'
import type { ZodType } from 'zod'
import { TERMINAL_QUERY_METHODS } from './terminal-query-methods'
import { TerminalHandle, TerminalInspectProcess } from './unary-schemas'

/** The method as registered, so a schema swap on the definition cannot pass unseen. */
function inspectProcessMethod() {
  const method = TERMINAL_QUERY_METHODS.find((entry) => entry.name === 'terminal.inspectProcess')
  if (!method) {
    throw new Error('terminal.inspectProcess is not registered')
  }
  return method
}

async function callRegisteredHandler(
  params: Record<string, unknown>
): Promise<{ terminal: string; options: unknown }> {
  const method = inspectProcessMethod()
  const parsed = (method.params as ZodType).parse(params)
  const inspectTerminalProcess = vi.fn(async () => ({
    foregroundProcess: null,
    hasChildProcesses: false
  }))
  await method.handler(parsed, { runtime: { inspectTerminalProcess } } as never, undefined as never)
  const [terminal, options] = inspectTerminalProcess.mock.calls[0] as unknown as [string, unknown]
  return { terminal, options }
}

describe('terminal.inspectProcess registration', () => {
  // The half the schema test alone cannot see: pointing the method back at the shared handle schema
  // compiles, parses, and silently drops the option. This exercises the registered definition.
  it('carries scanChildProcesses from the wire into the runtime call', async () => {
    await expect(
      callRegisteredHandler({ terminal: 'term_1', scanChildProcesses: true })
    ).resolves.toEqual({ terminal: 'term_1', options: { scanChildProcesses: true } })
  })

  it('carries it alongside the incarnation fence', async () => {
    await expect(
      callRegisteredHandler({
        terminal: 'term_1',
        expectedIncarnationId: 'inc-1',
        scanChildProcesses: true
      })
    ).resolves.toEqual({
      terminal: 'term_1',
      options: { expectedIncarnationId: 'inc-1', scanChildProcesses: true }
    })
  })

  it('keeps the legacy one-argument shape for a bare poll', async () => {
    await expect(callRegisteredHandler({ terminal: 'term_1' })).resolves.toEqual({
      terminal: 'term_1',
      options: undefined
    })
  })
})

describe('terminal.inspectProcess params', () => {
  it('preserves scanChildProcesses', () => {
    expect(TerminalInspectProcess.parse({ terminal: 'term_1', scanChildProcesses: true })).toEqual({
      terminal: 'term_1',
      scanChildProcesses: true
    })
  })

  it('preserves it alongside the incarnation fence', () => {
    expect(
      TerminalInspectProcess.parse({
        terminal: 'term_1',
        expectedIncarnationId: 'inc-1',
        scanChildProcesses: true
      })
    ).toEqual({ terminal: 'term_1', expectedIncarnationId: 'inc-1', scanChildProcesses: true })
  })

  it('leaves it absent for a polling caller', () => {
    expect(TerminalInspectProcess.parse({ terminal: 'term_1' })).toEqual({ terminal: 'term_1' })
  })

  // The shape that produced the bug, pinned so nobody "simplifies" the method back onto the shared
  // handle schema: TerminalHandle drops the option on the floor without complaining.
  it('shows why the shared handle schema could not carry it', () => {
    expect(TerminalHandle.parse({ terminal: 'term_1', scanChildProcesses: true })).toEqual({
      terminal: 'term_1'
    })
  })
})
