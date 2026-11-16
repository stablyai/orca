import '../../../rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { failedWorker, healthySibling } from './structured-chat-failed-worker.test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  dispatcher,
  host,
  request
} from './structured-chat-coordinator-mail-rig.test-fixture'

it.each([
  { failure: 'network', code: 'httpConnectionFailed', reset: false },
  { failure: 'network', code: 'httpConnectionFailed', reset: false, group: true },
  {
    failure: 'sign-in',
    code: { responseStreamDisconnected: { httpStatusCode: 401 } },
    reset: false
  },
  { failure: 'usage-limit', code: 'usageLimitExceeded', reset: false },
  { failure: 'usage-limit', code: 'usageLimitExceeded', reset: true },
  { failure: 'provider', code: 'serverOverloaded', reset: false },
  { failure: 'unknown', code: 'modelNotFound', reset: false }
])(
  'prints actual sender outcomes for $failure, reset=$reset, with a copy-ready coordinator retry',
  async (scenario) => {
    const { failure, code, reset } = scenario
    const group = 'group' in scenario && scenario.group === true
    const { dispatchId, worker, notify } = await failedWorker(
      code,
      failure,
      reset ? Date.now() + 3_600_000 : undefined
    )
    await host.deps.store.setUserConversationName(PEER_CHAT, 'Build worker', 'rename')
    await host.deps.store.setUserConversationName(COORDINATOR, 'Coordinator', 'rename')
    if (group) {
      await healthySibling()
    }
    const recipient = group ? '@all' : `dispatch:${dispatchId}`
    const { RuntimeClient } = await import('../../../../../cli/runtime/client')
    const { parseArgs, validateCommandAndFlags } = await import('../../../../../cli/arguments/args')
    const { COMMAND_SPECS: ORCHESTRATION_COMMAND_SPECS } = await import('../../../../../cli/specs')
    const { ORCHESTRATION_SEND_HANDLER } =
      await import('../../../../../cli/orchestration/messages/message-send-handler')
    const { RuntimeClientError } = await import('../../../../../cli/runtime/connection/types')
    const { ORCHESTRATION_FAILURE_RESUME_RUNTIME_CAPABILITY } =
      await import('../../../../../shared/orchestration/orchestration-runtime-capabilities')
    const originalExitCode = process.exitCode
    let latest: Record<string, unknown> = {}
    const detail = (): Record<string, unknown> =>
      Array.isArray(latest.deliveries)
        ? latest.deliveries.find((value) => value.state === 'held')
        : latest
    const transcript: string[] = []
    const messageId = (): string => {
      const message = detail().message
      if (
        !message ||
        typeof message !== 'object' ||
        !('id' in message) ||
        typeof message.id !== 'string'
      ) {
        throw new Error('Missing kept message identity')
      }
      return message.id
    }
    const execute = async (command: string, sessionId: string) => {
      vi.stubEnv('ORCA_AGENT_SESSION_ID', sessionId)
      const parsed = parseArgs(
        command.split(' ').slice(1),
        ORCHESTRATION_COMMAND_SPECS.map((spec) => spec.path),
        ORCHESTRATION_COMMAND_SPECS
      )
      validateCommandAndFlags(ORCHESTRATION_COMMAND_SPECS, parsed)
      const output: string[] = []
      const logging = vi
        .spyOn(console, 'log')
        .mockImplementation((line) => output.push(String(line)))
      process.exitCode = 0
      try {
        const client = new RuntimeClient('/tmp/idle-worker-cli-test', 10000, null, null, 'orca')
        const transport = vi.fn()
        transport.mockImplementation(async (method: string, params: Record<string, unknown>) => {
          if (method === 'status.get') {
            return {
              ok: true,
              result: { capabilities: [ORCHESTRATION_FAILURE_RESUME_RUNTIME_CAPABILITY] }
            }
          }
          const response = await dispatcher.dispatch(request(method, params, { sessionId }))
          if (!response.ok) {
            throw new RuntimeClientError(
              response.error.code,
              response.error.message,
              response.error.data
            )
          }
          if (!response.result || typeof response.result !== 'object') {
            throw new Error('Missing CLI receipt')
          }
          latest = { ...response.result }
          return response
        })
        vi.spyOn(client, 'call').mockImplementation(transport)
        await ORCHESTRATION_SEND_HANDLER['orchestration send']!({
          flags: parsed.flags,
          json: parsed.flags.has('json'),
          cwd: '/tmp',
          client
        })
        transcript.push(
          `sender=${sessionId === COORDINATOR ? 'coordinator' : 'other bot'}\n$ ${command}\n${output.join('\n')}\nexit=${process.exitCode ?? 0}`
        )
      } finally {
        logging.mockRestore()
      }
      return output.join('\n')
    }
    try {
      const initial = await execute(
        `orca orchestration send --to ${recipient} --subject continue`,
        COORDINATOR
      )
      expect(process.exitCode).toBe(1)
      expect(detail()).toMatchObject({ delivered: false, state: 'held', reason: { failure } })
      expect(initial).toContain(messageId())
      expect(initial).toContain(`dispatch:${dispatchId}`)
      expect(initial).toContain('Build worker')
      if (!group) {
        await execute(
          `orca orchestration send --to dispatch:${dispatchId} --subject continue`,
          PEER_CHAT
        )
      }
      expect(process.exitCode).toBe(1)
      expect(detail()).toMatchObject({ delivered: false, state: 'held', reason: { failure } })
      expect(detail().deliveryHint).not.toMatch(
        /orca_session_id:|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/i
      )
      if (!group && (failure === 'network' || failure === 'provider')) {
        expect(detail().deliveryHint).toContain('Coordinator')
      }
      for (const mode of ['--full', '--json']) {
        const output = await execute(
          `orca orchestration send --to ${recipient} --subject continue ${mode}`,
          COORDINATOR
        )
        expect(process.exitCode).toBe(1)
        expect(detail()).toMatchObject({ delivered: false, state: 'held', reason: { failure } })
        expect(output).toContain(messageId())
        expect(output).toContain(`dispatch:${dispatchId}`)
      }
      if (failure === 'network') {
        const printed = initial.split('\n').find((line) => line.startsWith('Resume once: '))
        if (!printed) {
          throw new Error('Missing copy-ready coordinator command')
        }
        await execute(printed.slice('Resume once: '.length), COORDINATOR)
        expect(latest.recoveryMessage).toContain('Build worker')
        expect(latest).toMatchObject({ state: 'resuming', recovery: { status: 'resumed' } })
        expect(process.exitCode ?? 0).toBe(0)
        await vi.waitFor(() => expect(worker.turns).toHaveLength(2), WAIT)
        const input = worker.turns[1]!
        notify('turn/started', { turn: { id: 'turn-2' } })
        notify('item/completed', {
          item: {
            type: 'userMessage',
            id: `echo-${input.clientUserMessageId}`,
            clientId: input.clientUserMessageId,
            content: [{ type: 'text', text: 'continue' }]
          }
        })
        const error = { message: 'Connection unavailable', codexErrorInfo: 'httpConnectionFailed' }
        notify('error', { threadId: worker.threadId, turnId: 'turn-2', willRetry: false, error })
        notify('turn/completed', { turn: { id: 'turn-2', status: 'failed', error } })
        await host.flushStreamedEvents(PEER_CHAT)
        await vi.waitFor(
          async () => expect((await host.heldDelivery(PEER_CHAT))?.recoveryUsed).toBe(true),
          WAIT
        )
        await execute(
          `orca orchestration send --to dispatch:${dispatchId} --subject continue`,
          COORDINATOR
        )
        expect(process.exitCode).toBe(1)
        expect(latest).toMatchObject({ delivered: false, state: 'held', recoveryUsed: true })
      }
    } finally {
      process.exitCode = originalExitCode ?? 0
      vi.unstubAllEnvs()
      console.info(`CLI evidence ${failure}\n${transcript.join('\n\n')}`)
    }
  }
)
