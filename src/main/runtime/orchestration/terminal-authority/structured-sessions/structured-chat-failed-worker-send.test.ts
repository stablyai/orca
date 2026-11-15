import '../../../rpc/dispatch/testing/unused-default-rpc-methods.test-fixture'
import { expect, it, vi } from 'vitest'
import { formatOrcaSessionAddress } from '../../../../../shared/orca-session-address'
import { testOrcaSessionId } from '../../../../../shared/orca-session-address-test-fixture'
import { idOf } from '../../../rpc/orchestration/callers/session.test-fixture'
import {
  COORDINATOR,
  PEER_CHAT,
  WAIT,
  call,
  coordinatorRunAndTask,
  db,
  dispatcher,
  host,
  openChat,
  request
} from './structured-chat-coordinator-mail-rig.test-fixture'

const workerAddress = formatOrcaSessionAddress(testOrcaSessionId(PEER_CHAT))

async function failedWorker(code: unknown = 'httpConnectionFailed', failure = 'network') {
  await openChat(COORDINATOR)
  const worker = await openChat(PEER_CHAT)
  const { taskId } = await coordinatorRunAndTask()
  const assigning = call(
    'orchestration.dispatch',
    { task: taskId, to: workerAddress, inject: true },
    { sessionId: COORDINATOR }
  )
  await vi.waitFor(() => expect(worker.turns).toHaveLength(1), WAIT)
  const input = worker.turns[0]!
  const notify = (method: string, params: unknown) =>
    worker.handlers.onNotification?.(method, params)
  notify('turn/started', { turn: { id: 'turn-1' } })
  notify('item/completed', {
    item: {
      type: 'userMessage',
      id: `echo-${input.clientUserMessageId}`,
      clientId: input.clientUserMessageId,
      content: [{ type: 'text', text: 'task' }]
    }
  })
  await host.flushStreamedEvents(PEER_CHAT)
  const assigned = await assigning
  const dispatchId = idOf(assigned.dispatch)
  const error = { message: 'Connection unavailable', codexErrorInfo: code }
  notify('error', { threadId: worker.threadId, turnId: 'turn-1', willRetry: false, error })
  notify('turn/completed', { turn: { id: 'turn-1', status: 'failed', error } })
  await host.flushStreamedEvents(PEER_CHAT)
  await vi.waitFor(
    async () => expect((await host.heldDelivery(PEER_CHAT))?.reason.failure).toBe(failure),
    WAIT
  )
  return { dispatchId, worker, notify }
}

function failureId(receipt: Record<string, unknown>): string {
  if (typeof receipt.failureId !== 'string') {
    throw new Error('Missing observed failure id')
  }
  return receipt.failureId
}

it('returns a kept, typed negative delivery through the real RPC and preserves it on old-client completed-receipt replay', async () => {
  const { dispatchId } = await failedWorker()
  const sent = request(
    'orchestration.send',
    { to: `dispatch:${dispatchId}`, subject: 'kept instruction' },
    { sessionId: COORDINATOR }
  )
  const first = await dispatcher.dispatch(sent)
  expect(first).toMatchObject({
    ok: false,
    error: {
      code: 'recipient_delivery_held',
      data: {
        messageKept: true,
        delivered: false,
        state: 'held',
        reason: { kind: 'worker_failed', failure: 'network' },
        target: { sessionId: PEER_CHAT, dispatchId }
      }
    }
  })
  if (
    first.ok ||
    !first.error.data ||
    typeof first.error.data !== 'object' ||
    !('message' in first.error.data)
  ) {
    throw new Error('Missing kept message receipt')
  }
  const replay = await dispatcher.dispatch(sent)
  expect(replay).toMatchObject({
    ok: false,
    error: {
      code: 'recipient_delivery_held',
      data: {
        message: first.error.data.message,
        delivered: false,
        state: 'held'
      }
    }
  })
  expect(
    db
      .getUnreadMessages(`dispatch:${dispatchId}`)
      .filter((row) => row.subject === 'kept instruction')
      .map((row) => row.subject)
  ).toEqual(['kept instruction'])
})

it('permits only the current coordinator to consume the observed failure once, without duplicating the kept input', async () => {
  const { dispatchId } = await failedWorker()
  const held = await call(
    'orchestration.send',
    { to: `dispatch:${dispatchId}`, subject: 'keep this work', deliveryOutcome: true },
    { sessionId: COORDINATOR }
  )
  expect(held).toMatchObject({
    delivered: false,
    state: 'held',
    reason: { kind: 'worker_failed', failure: 'network' }
  })
  const token = failureId(held)
  const unauthorized = await dispatcher.dispatch(
    request(
      'orchestration.send',
      {
        from: workerAddress,
        to: `dispatch:${dispatchId}`,
        resume: true,
        expectedFailureId: token,
        deliveryOutcome: true
      },
      { sessionId: PEER_CHAT }
    )
  )
  expect(unauthorized).toMatchObject({ ok: false, error: { code: 'forbidden' } })
  const resumed = await call(
    'orchestration.send',
    { to: `dispatch:${dispatchId}`, resume: true, expectedFailureId: token, deliveryOutcome: true },
    { sessionId: COORDINATOR }
  )
  expect(resumed).toMatchObject({
    delivered: false,
    state: 'resuming',
    recovery: { status: 'resumed' }
  })
  const again = await dispatcher.dispatch(
    request(
      'orchestration.send',
      {
        to: `dispatch:${dispatchId}`,
        resume: true,
        expectedFailureId: token,
        deliveryOutcome: true
      },
      { sessionId: COORDINATOR }
    )
  )
  expect(again).toMatchObject({ ok: false, error: { code: 'worker_resume_already-used' } })
  expect(
    db
      .getUnreadMessages(`dispatch:${dispatchId}`)
      .filter((row) => row.subject === 'keep this work')
      .map((row) => row.subject)
  ).toEqual(['keep this work'])
})

it('rejects a stale observed token before it can save a new message', async () => {
  const { dispatchId } = await failedWorker()
  const response = await dispatcher.dispatch(
    request(
      'orchestration.send',
      {
        to: `dispatch:${dispatchId}`,
        resume: true,
        expectedFailureId: '0'.repeat(64),
        subject: 'must not be kept',
        deliveryOutcome: true
      },
      { sessionId: COORDINATOR }
    )
  )
  expect(response).toMatchObject({
    ok: false,
    error: { code: 'worker_resume_stale-failure', data: { effectsApplied: false } }
  })
  expect(
    db
      .getUnreadMessages(`dispatch:${dispatchId}`)
      .filter((row) => row.subject === 'must not be kept')
  ).toEqual([])
  expect(await host.heldDelivery(PEER_CHAT)).toMatchObject({
    state: 'held',
    reason: { failure: 'network' }
  })
})

it.each([
  ['network', 'httpConnectionFailed'],
  ['sign-in', { responseStreamDisconnected: { httpStatusCode: 401 } }],
  ['usage-limit', 'usageLimitExceeded']
])(
  'prints actual sender outcomes for %s, with a copy-ready coordinator retry',
  async (failure, code) => {
    const { dispatchId, worker, notify } = await failedWorker(code, String(failure))
    const { RuntimeClient } = await import('../../../../../cli/runtime/client')
    const { parseArgs, validateCommandAndFlags } = await import('../../../../../cli/arguments/args')
    const { ORCHESTRATION_COMMAND_SPECS } = await import('../../../../../cli/specs/orchestration')
    const { ORCHESTRATION_SEND_HANDLER } =
      await import('../../../../../cli/orchestration/messages/message-send-handler')
    const { RuntimeClientError } = await import('../../../../../cli/runtime/connection/types')
    const { ORCHESTRATION_FAILURE_RESUME_RUNTIME_CAPABILITY } =
      await import('../../../../../shared/orchestration/orchestration-runtime-capabilities')
    const originalExitCode = process.exitCode
    let latest: Record<string, unknown> = {}
    const transcript: string[] = []
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
        transcript.push(`$ ${command}\n${output.join('\n')}\nexit=${process.exitCode ?? 0}`)
      } finally {
        logging.mockRestore()
      }
      return output.join('\n')
    }
    try {
      const initial = await execute(
        `orca orchestration send --to dispatch:${dispatchId} --subject continue`,
        COORDINATOR
      )
      expect(process.exitCode).toBe(1)
      expect(latest).toMatchObject({ delivered: false, state: 'held', reason: { failure } })
      await execute(
        `orca orchestration send --to dispatch:${dispatchId} --subject continue`,
        PEER_CHAT
      )
      expect(process.exitCode).toBe(1)
      expect(latest).toMatchObject({ delivered: false, state: 'held', reason: { failure } })
      if (failure === 'network') {
        const printed = initial.split('\n').find((line) => line.startsWith('Resume once: '))
        if (!printed) {
          throw new Error('Missing copy-ready coordinator command')
        }
        await execute(printed.slice('Resume once: '.length), COORDINATOR)
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
