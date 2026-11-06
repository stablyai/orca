import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/host/structured-agent-session-logger'

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

vi.mock('./agent-session/structured-agent-session-runtime', () => ({
  ensureStructuredAgentSessionHost: vi.fn(
    async (deps: Record<string, unknown> & { logger: StructuredAgentSessionLogger }) => {
      installed.deps = deps
      installed.logger = deps.logger
    }
  )
}))

import { OrcaRuntimeService } from './orca-runtime'

describe('checked runtime construction', () => {
  it('installs subscription callbacks on the runtime with their real registry receiver', () => {
    const runtime = new OrcaRuntimeService()
    const cleanup = vi.fn()
    runtime.registerSubscriptionCleanup('construction-subscription', cleanup)
    runtime.cleanupSubscription('construction-subscription')
    expect(cleanup).toHaveBeenCalledOnce()
    runtime.cleanupSubscription('construction-subscription')
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
