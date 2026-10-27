// A build without ORCA_SIDEBAR_INPUTS=main (every shipped one) keeps none of main's sidebar inputs.
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { ALL_RPC_METHODS } from '../rpc/methods'
import { SIDEBAR_INPUT_METHODS } from '../rpc/methods/sidebar-inputs'

describe('sidebar inputs with the switch off', () => {
  it('builds no producer and registers no sidebarInputs method', () => {
    const runtime = new OrcaRuntimeService()
    expect(runtime.sidebarFacts).toBeNull()
    expect(runtime.pairedServerRows).toBeNull()
    expect(runtime.repoIconDataUrls).toBeNull()
    expect(runtime.workspaceLifecycle).toBeNull()
    expect(runtime.collapseWriteOrder).toBeNull()
    const gated = new Set<string>(SIDEBAR_INPUT_METHODS.map((method) => method.name))
    expect(ALL_RPC_METHODS.filter((method) => gated.has(method.name))).toEqual([])
  })
})
