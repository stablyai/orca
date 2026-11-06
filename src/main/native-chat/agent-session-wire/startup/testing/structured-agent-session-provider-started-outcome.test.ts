import { beforeEach, expect, it, vi } from 'vitest'
import canonicalRefusal from '../../../../codex/app-server/fixtures/start-resume-canonical-filename-refusal.json'
import { CodexAppServerRequestError } from '../../../../codex/app-server/codex-app-server-request-error'
import { CodexAppServerExitError } from '../../../../codex/app-server/codex-app-server-exit-error'
import { codexStartFailure } from '../../../../codex/app-server/codex-startup-outcome'
import { readStructuredRewindRecovery } from '../../rewind/structured-rewind-recovery'
import type * as RewindRecovery from '../../rewind/structured-rewind-recovery'
import {
  settleStructuredAgentSessionProviderStarted,
  type StructuredAgentSessionProviderStartedContext
} from '../structured-agent-session-provider-started'
import type { AgentSessionStartFailure } from '../structured-agent-session-start-failure'

vi.mock('../../rewind/structured-rewind-recovery', async (importOriginal) => ({
  ...(await importOriginal<typeof RewindRecovery>()),
  readStructuredRewindRecovery: vi.fn()
}))

const SESSION = 'session-1'
const OPENED = { sessionId: SESSION, fence: 3, acquisitionGeneration: 'g-1', reportedOptions: {} }
const died = codexStartFailure(new CodexAppServerExitError('codex app-server connection ended'))
let ending: AgentSessionStartFailure | undefined

function context(childGeneration = 'g-1'): StructuredAgentSessionProviderStartedContext {
  const session = {
    journal: {},
    child: { generation: childGeneration, fence: 3, phase: 'starting' }
  }
  const members = {
    deps: {
      adapter: { startupEnding: () => ending },
      store: { getRecord: () => null, getConversation: () => ({ currentFence: 3 }) },
      logger: { warn: vi.fn() }
    },
    sessions: new Map([[SESSION, session]]),
    serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
    now: () => 0,
    runtimeState: {
      startupAttempts: { onClock: () => true, rootExit: () => new Promise<void>(() => {}) },
      acquireAborts: {}
    },
    wakeDelivery: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: settlement reads only these members before its verdict.
  return members as unknown as StructuredAgentSessionProviderStartedContext
}

beforeEach(() => {
  ending = undefined
  vi.mocked(readStructuredRewindRecovery).mockReset().mockResolvedValue(null)
})

it("keeps a required read's final answer over the child's later death", async () => {
  const answer = new CodexAppServerRequestError(
    'thread/read',
    canonicalRefusal.code,
    canonicalRefusal.message
  )
  vi.mocked(readStructuredRewindRecovery).mockRejectedValue(codexStartFailure(answer))
  ending = died
  const outcome = await settleStructuredAgentSessionProviderStarted(context(), OPENED)
  expect(outcome).toMatchObject({ retry: 'never', cause: answer })
})

it('answers an unanswered death after a successful open with the adapter verdict', async () => {
  ending = died
  expect(await settleStructuredAgentSessionProviderStarted(context(), OPENED)).toBe(died)
  expect(died.retry).toBe('safe')
})

it('retires only its own owner once the child was replaced', async () => {
  expect(await settleStructuredAgentSessionProviderStarted(context('g-2'), OPENED)).toBe('stale')
})

it('ends the start on a reported death while its bookkeeping is still blocked', async () => {
  ending = died
  const blocked = context()
  blocked.flushLifecycle = () => new Promise(() => {})
  blocked.runtimeState.startupAttempts.rootExit = () => Promise.resolve()
  expect(await settleStructuredAgentSessionProviderStarted(blocked, OPENED)).toBe(died)
})
