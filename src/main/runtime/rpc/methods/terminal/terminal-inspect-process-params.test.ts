// Declare scanChildProcesses on this RPC only; shared handle schemas would silently strip it while sibling methods must refuse it.
import { describe, expect, it, vi } from 'vitest'
import type { ZodType } from 'zod'
import { TERMINAL_QUERY_METHODS } from './terminal-query-methods'
import { TerminalHandle } from '../../../../../shared/rpc-contract/terminal-unary-params'
import { eraseRpcMethods } from '../../core'

/** The method as registered, so a schema swap on the definition cannot pass unseen. */
function inspectProcessMethod() {
  const method = eraseRpcMethods(TERMINAL_QUERY_METHODS).find(
    (entry) => entry.name === 'terminal.inspectProcess'
  )
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
  await method.handler(parsed, { runtime: { inspectTerminalProcess } } as never)
  const [terminal, options] = inspectTerminalProcess.mock.calls[0] as unknown as [string, unknown]
  return { terminal, options }
}

describe('terminal.inspectProcess registration', () => {
  // Drive the registered method too: swapping in shared handle schema silently drops this option.
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
  // Pin the shared schema's silent strip so it cannot replace this method's dedicated schema.
  it('shows why the shared handle schema could not carry it', () => {
    expect(TerminalHandle.parse({ terminal: 'term_1', scanChildProcesses: true })).toEqual({
      terminal: 'term_1'
    })
  })
})
