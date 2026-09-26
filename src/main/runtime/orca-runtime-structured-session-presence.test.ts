import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { OrcaRuntimeService } from './orca-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

function runtimeWithStoreOnDisk(onDisk: boolean): {
  runtime: OrcaRuntimeService
  ensureHost: ReturnType<typeof vi.fn>
} {
  const runtime = new OrcaRuntimeService()
  const ensureHost = vi.fn(async () => undefined)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: overrides two protected members the query reads; nothing else is touched.
  const internal = runtime as unknown as {
    hasPersistedStructuredAgentSessionStore(): boolean
    ensureStructuredAgentSessionHost(): Promise<void>
  }
  internal.hasPersistedStructuredAgentSessionStore = () => onDisk
  internal.ensureStructuredAgentSessionHost = ensureHost
  return { runtime, ensureHost }
}

function hostWithRecords(count: number): never {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query reads only deps.store.listRecords.
  return {
    deps: { store: { listRecords: () => Array.from({ length: count }, () => ({})) } }
  } as never
}

describe('hasStructuredAgentSessionRecords', () => {
  it('answers no from the missing store file without installing the host', () => {
    const { runtime, ensureHost } = runtimeWithStoreOnDisk(false)

    expect(runtime.hasStructuredAgentSessionRecords()).toBe(false)
    expect(ensureHost).not.toHaveBeenCalled()
  })

  it('answers yes for a store on disk the host has not opened yet', () => {
    expect(runtimeWithStoreOnDisk(true).runtime.hasStructuredAgentSessionRecords()).toBe(true)
  })

  it('counts the installed host records rather than trusting the file', () => {
    const { runtime } = runtimeWithStoreOnDisk(true)

    setStructuredAgentSessionHost(hostWithRecords(0))
    expect(runtime.hasStructuredAgentSessionRecords()).toBe(false)
    setStructuredAgentSessionHost(hostWithRecords(2))
    expect(runtime.hasStructuredAgentSessionRecords()).toBe(true)
  })
})
