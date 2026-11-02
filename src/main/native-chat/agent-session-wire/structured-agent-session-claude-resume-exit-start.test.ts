import { expect, it, vi } from 'vitest'
import { ClaudeStructuredSessionAdapter } from '../../claude/structured/claude-structured-session-adapter'
import {
  PROVIDER_SESSION_ID,
  fakeClaude
} from '../../claude/structured/claude-structured-session-test-support'
import { structuredClaudeLifecycleEvent } from '../../runtime/structured-claude-runtime-adapter'
import { withObservedProviderExit } from './structured-agent-session-failure-text'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import type { StructuredAgentSessionSinkBarrier } from './structured-agent-session-event-sink'
import { STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS } from './structured-agent-session-startup-attempt-contract'
import {
  accept,
  closeSession,
  eventually,
  host,
  providerOpen,
  registerStartupAttemptHostTests,
  restartWith,
  submission
} from './structured-agent-session-startup-attempt-host-test-support'

registerStartupAttemptHostTests()

const STARTED_AT = 1_800_000_000_000

it('ends a resumed start that exits during transcript catch-up without awaiting a cursor write', async () => {
  const claude = fakeClaude()
  const catchUp = Promise.withResolvers<StructuredAgentSessionSinkBarrier>()
  const persisted = Promise.withResolvers<void>()
  const persistHandle = vi.fn(() => persisted.promise)
  let catchingUp = false
  let ended = 0
  const lifecycleTypes: (string | undefined)[] = []
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'claude',
      options: {},
      cwd: '/work/repo',
      claudeConfigDir: '/accounts/claude',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: 'saved-leaf',
      resumesTranscript: true,
      continuesChain: true,
      cliFlag: async () => 'supported' as const
    }),
    openConnection: claude.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    persistHandle,
    onEvent: (event) => {
      if (event.type === 'ended') {
        ended += 1
        const lifecycle = structuredClaudeLifecycleEvent(event)
        lifecycleTypes.push(lifecycle?.type)
        if (lifecycle) {
          void host.handleAdapterEvent(lifecycle)
        }
      }
    }
  })
  await restartWith((input) => {
    if (!input.events) {
      throw new Error('expected the host event sink')
    }
    return adapter.acquire({
      ...input,
      events: {
        ...input.events,
        written: () => {
          catchingUp = true
          return catchUp.promise
        }
      }
    })
  })
  providerOpen.mockImplementation(adapter.open)
  closeSession.mockImplementation(adapter.closeSession)
  host.deps.adapter.releaseAcquisition = adapter.releaseAcquisition
  vi.setSystemTime(STARTED_AT)
  const id = await accept('resume queued message')
  // Initialize has answered; the open still waits on the journal before catch-up.
  await eventually(() => expect(catchingUp).toBe(true))
  const flight = host.collaboratorsForTests().runtimeState.startFlights.get(SESSION)!
  const connection = claude.connections[0]
  connection.closed = true
  connection.exitVerdict = { root: 'exited', tree: 'exited' }
  connection.handlers.onExit?.(withObservedProviderExit(new Error('claude exited (code 1)')), {
    expected: false
  })
  await vi.advanceTimersByTimeAsync(2_100)
  expect(ended).toBe(1)
  expect(lifecycleTypes).toEqual(['ended'])
  expect(persistHandle).not.toHaveBeenCalled()
  catchUp.resolve({ ok: true })
  persisted.resolve()
  await adapter.drainObservedExits()
  await flight.outcome
  await eventually(async () => expect((await submission(id))?.dispatchState).not.toBe('pending'))
  expect(Date.now() - STARTED_AT).toBeLessThan(STRUCTURED_AGENT_SESSION_STARTUP_CEILING_MS)
  claude.dispose()
  await adapter.closeAll()
})
