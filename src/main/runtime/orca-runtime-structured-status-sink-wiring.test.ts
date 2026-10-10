import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const installed = vi.hoisted(() => {
  const state: {
    deps: Record<string, unknown> | null
    logger: StructuredAgentSessionLogger | null
  } = { deps: null, logger: null }
  return state
})

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

vi.mock('./structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(
    async (deps: Record<string, unknown> & { logger: StructuredAgentSessionLogger }) => {
      installed.deps = deps
      installed.logger = deps.logger
    }
  )
}))

import { OrcaRuntimeService } from './orca-runtime'
import { _resetTracerForTests, setActiveSink } from '../observability/tracer'
import type { StructuredAgentSessionStatusSink } from '../native-chat/agent-session-wire/structured-agent-session-status-feed'

describe('structured status sink wiring', () => {
  afterEach(() => {
    _resetTracerForTests()
    vi.restoreAllMocks()
  })

  it('hands the host the sink the runtime was constructed with', async () => {
    installed.deps = null
    const sink: StructuredAgentSessionStatusSink = { publish: vi.fn(), forget: vi.fn() }
    const runtime = new OrcaRuntimeService(null, undefined, { structuredAgentStatusSink: sink })

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps?.['statusSink']).toBe(sink)
  })

  // The runtime class does not typecheck its own calls, so the required logger is pinned here:
  // a logger that writes nowhere would pass every host test while the desktop dropped failures.
  it('hands the host the trace-file logger', async () => {
    installed.logger = null
    const push = vi.fn()
    setActiveSink({ push, flush: () => {}, close: () => {} })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()
    const installedLogger = (): StructuredAgentSessionLogger | null => installed.logger
    installedLogger()?.warn('renewing a chat lease failed', {
      scope: 'lease-renewal',
      sessionId: 'session-1',
      error: new Error('database is locked')
    })

    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'agentSession.lease-renewal',
        attributes: expect.objectContaining({ sessionId: 'session-1' }),
        exit: expect.objectContaining({ _tag: 'Failure' })
      })
    )
  })

  it('installs without a sink when none was provided', async () => {
    installed.deps = null
    const runtime = new OrcaRuntimeService()

    await runtime.ensureStructuredAgentSessionHost()

    expect(installed.deps).not.toBeNull()
    expect('statusSink' in (installed.deps ?? {})).toBe(false)
  })
})
