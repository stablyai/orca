// Permission seeds are optional decoration: a host whose permission read throws still lists its chat tabs.
import { afterEach, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { record } from '../native-chat/agent-session-wire/structured-agent-session-restart-resume-test-harness'
import { OrcaRuntimeService } from './orca-runtime'

afterEach(() => {
  setStructuredAgentSessionHost(null)
  vi.restoreAllMocks()
})

it('lists a chat tab without a permission seed when the permission read throws', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const saved = { ...record({ chain: [] }), options: { permissionMode: 'auto' } }
  const permissionRevision = vi.fn(() => {
    throw new Error('permission store unavailable')
  })
  const logger = {
    warn: vi.fn(() => {
      throw new Error('logger unavailable')
    }),
    error: vi.fn()
  }
  const partialHost = {
    hasSession: () => true,
    deps: { store: { getRecord: () => saved, permissionRevision }, logger }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial host; listing tabs reads only deps.store and deps.logger.
  setStructuredAgentSessionHost(partialHost as never)
  const runtime = Object.assign(new OrcaRuntimeService(), {
    ensureStructuredAgentSessionHost: async () => undefined,
    notifyMessageArrived: vi.fn()
  })
  await runtime.publishStructuredAgentSessionTab({
    workspaceId: saved.location.workspaceId,
    sessionId: saved.sessionId,
    agent: 'codex',
    activate: true
  })

  const listed = await runtime.listMobileSessionTabs(`id:${saved.location.workspaceId}`)

  expect(permissionRevision).toHaveBeenCalled()
  expect(logger.warn).toHaveBeenCalled()
  const tab = listed.tabs.find((candidate) => candidate.type === 'agent-session')
  expect(tab).toMatchObject({ sessionId: saved.sessionId })
  expect(tab).not.toHaveProperty('permissionSeed')
})
