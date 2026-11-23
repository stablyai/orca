import { ChildProcess } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createClaudeCodeProcessSpawn } from '../../child-process/claude-agent-sdk-process-spawn'
import {
  ClaudeControlRequestTimeoutError,
  runClaudeControl
} from '../../sdk-transport/claude-agent-sdk-control-requests'
import { ClaudeJournalBoundDelivery } from '../journal/claude-journal-bound-delivery'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'
import {
  bindClaudeJournalReadingControl,
  createClaudePermissionNoticeRecheck
} from '../journal/claude-structured-session-journal-control'
import {
  seedClaudePermissionNotice,
  type ClaudePermissionNoticeSession
} from './claude-full-access-refusal-notice'
import type { ClaudePermissionNoticeIntent } from './claude-permission-notice-mode'
import { ClaudePromptRegistry } from './claude-prompt-registry'
import { claudeLaunchPermissions } from './claude-structured-inbound-control'

const PROVIDER_SESSION = 'provider-session'
const NOTICE_PREFIX = 'full-access-refused:claude:'

function journalRows() {
  const rows: {
    id: string
    text: string
    scope: Parameters<StructuredAgentSessionEventSink['appendItem']>[2]['turnScope']
  }[] = []
  let backpressured = false
  let onPause: (() => void) | undefined
  let onDrain: (() => void) | undefined
  const sink: StructuredAgentSessionEventSink = {
    appendItem: () => {},
    appendTombstone: () => {},
    publish: () => {},
    tryAppendItem: (key, body, { turnScope }) => {
      if (
        key.provider === 'orca' &&
        key.clientMessageId?.startsWith(NOTICE_PREFIX) &&
        body.kind === 'status'
      ) {
        if (backpressured) {
          return { accepted: false, reason: 'backpressure' }
        }
        rows.push({ id: key.clientMessageId, text: body.text, scope: turnScope })
      }
      return { accepted: true }
    },
    bindReadingControl: ({ pauseReading, resumeReading }) => {
      onPause = pauseReading
      onDrain = resumeReading
      return () => {
        onPause = undefined
        onDrain = undefined
      }
    }
  }
  return {
    sink,
    rows,
    texts: () => rows.map((row) => row.text),
    pause: () => onPause?.(),
    block: () => {
      backpressured = true
    },
    drain: () => {
      backpressured = false
      onDrain?.()
    }
  }
}

function wireLine(record: object): string {
  return `${JSON.stringify(record)}\n`
}

function reply(id: string, response?: object) {
  return { type: 'control_response', response: { subtype: 'success', request_id: id, response } }
}

function report(mode: string, subtype = 'status') {
  return { type: 'system', subtype, permissionMode: mode, session_id: PROVIDER_SESSION }
}

function toolRequest(id: string) {
  return { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool' } }
}

function controlledClaude(
  intent: ClaudePermissionNoticeIntent,
  journal = journalRows(),
  seeded = true
) {
  let published = true
  let retired = false
  const delivery = new ClaudeJournalBoundDelivery(journal.sink, () => published)
  const session: ClaudePermissionNoticeSession = {
    launchIntent: { permissionMode: intent },
    appliedInputOptions: new Map(),
    permissionNoticeSeeded: seeded
  }
  const translator = createClaudeJournalTranslator({
    sink: journal.sink,
    delivery,
    permissionNoticeSession: () => (retired ? null : session)
  })
  const recheckPermissionNotice = createClaudePermissionNoticeRecheck(
    translator,
    (run) => delivery.deliver(run),
    (error) => {
      throw error
    }
  )
  const prompts = new ClaudePromptRegistry()
  const permissions = claudeLaunchPermissions(
    { sessionId: 'chat', prompts, emit: () => {}, recheckPermissionNotice },
    {
      options:
        intent === 'auto'
          ? { permissionMode: 'auto' }
          : { extraArgs: { 'dangerously-skip-permissions': null } },
      providerSessionId: PROVIDER_SESSION
    }
  )
  Object.assign(session, permissions.sessionFacts)

  const stdout = new PassThrough()
  const raw = Object.assign(new ChildProcess(), {
    stdin: new Writable({ write: (_chunk, _encoding, callback) => callback() }),
    stdout,
    stderr: new PassThrough()
  })
  const spawner = createClaudeCodeProcessSpawn(() => raw, 'win32', undefined, permissions.handlers)
  const child = spawner.spawn({
    command: 'claude',
    args: [],
    env: {},
    signal: new AbortController().signal
  })
  child.stdout.on('data', () => {})
  bindClaudeJournalReadingControl(
    journal.sink,
    { pauseReading: () => {}, resumeReading: () => {} },
    translator,
    delivery
  )

  const write = (request_id: string, request: Record<string, string>): void => {
    child.stdin.write(wireLine({ type: 'control_request', request_id, request }), 'utf8')
  }
  return {
    session,
    journal,
    translator,
    write,
    mode: (id: string, mode: string) => write(id, { subtype: 'set_permission_mode', mode }),
    stdout,
    send: (...records: object[]) => stdout.write(records.map(wireLine).join('')),
    frame: (message: Record<string, unknown>) => {
      delivery.deliver(() => translator.handle({ type: 'message', sessionId: 'chat', message }))
    },
    pause: () => {
      published = false
    },
    resume: () => {
      published = true
      delivery.flush()
    },
    seed: (reads: Parameters<typeof seedClaudePermissionNotice>[1]) =>
      seedClaudePermissionNotice(session, reads, () => {
        if (retired) {
          throw new Error('acquisition retired')
        }
      }),
    recheckPermissionNotice,
    allowed: async (id: string, toolName = 'Bash') => {
      const abort = new AbortController()
      const permission = permissions.handlers.canUseTool!(
        toolName,
        {},
        {
          requestId: id,
          signal: abort.signal,
          toolUseID: id
        }
      )
      abort.abort()
      return (await permission)?.behavior === 'allow'
    },
    retire: () => {
      retired = true
      permissions.handlers.retirePermissionNotice?.()
      translator.dispose()
      child.stdin.end()
      stdout.end()
      raw.stderr.end()
    }
  }
}

it('reconciles late Auto success without a journal frame and reports a later Ask downgrade', async () => {
  const claude = controlledClaude('auto')
  claude.send(report('auto', 'init'))
  claude.mode('ask', 'default')
  claude.send(reply('ask'))
  await Promise.resolve()
  expect(claude.journal.texts()).toEqual(['Claude uses Ask for approval instead.'])

  const unanswered = Promise.withResolvers<void>()
  await expect(
    runClaudeControl(
      'set_permission_mode',
      () => {
        claude.mode('retry', 'auto')
        return unanswered.promise
      },
      1
    )
  ).rejects.toBeInstanceOf(ClaudeControlRequestTimeoutError)
  claude.frame({ type: 'system', subtype: 'status', session_id: PROVIDER_SESSION })
  expect(claude.journal.texts()).toEqual([
    'Claude uses Ask for approval instead.',
    "Claude's permission mode is unconfirmed."
  ])

  claude.send(reply('retry'))
  unanswered.resolve()
  await Promise.resolve()
  claude.journal.pause()
  claude.session.appliedInputOptions?.set('buildPermissionMode', 'auto')
  claude.send(report('default'), report('default'))
  await Promise.resolve()
  expect(claude.journal.texts()).toHaveLength(3)
  claude.journal.drain()
  expect(claude.journal.texts()).toEqual([
    'Claude uses Ask for approval instead.',
    "Claude's permission mode is unconfirmed.",
    'Claude uses Approve for me again.',
    'Claude uses Ask for approval instead.'
  ])
  claude.retire()
})

it('keeps overlapping mode replies and Full access tool authorization in wire order', async () => {
  const claude = controlledClaude('bypassPermissions')
  claude.write('initialize', { subtype: 'initialize' })
  claude.send({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'initialize',
      response: { current_permission_mode: 'bypassPermissions' },
      pending_permission_requests: [toolRequest('redelivered')]
    }
  })
  expect(await claude.allowed('redelivered')).toBe(true)
  claude.send(report('default'))
  await Promise.resolve()
  expect(claude.journal.texts()).toEqual(['Claude uses Ask for approval instead.'])

  claude.pause()
  claude.mode('ask', 'default')
  claude.mode('auto', 'auto')
  claude.mode('plan', 'plan')
  const ask = wireLine(reply('ask'))
  claude.stdout.write(ask.slice(0, 18))
  await Promise.resolve()
  claude.stdout.write(
    ask.slice(18) +
      [
        report('bypassPermissions'),
        toolRequest('before'),
        toolRequest('plan-approval'),
        report('default'),
        toolRequest('before'),
        toolRequest('after'),
        reply('auto'),
        reply('plan')
      ]
        .map(wireLine)
        .join('')
  )
  claude.frame(report('bypassPermissions', 'init'))
  claude.frame(report('default'))
  expect(await claude.allowed('before')).toBe(true)
  expect(await claude.allowed('after')).toBe(false)
  expect(await claude.allowed('unseen')).toBe(false)
  expect(await claude.allowed('plan-approval', 'ExitPlanMode')).toBe(false)
  expect(claude.journal.texts()).toEqual(['Claude uses Ask for approval instead.'])

  claude.journal.block()
  claude.resume()
  expect(claude.session.fullAccessRefusalNoticeId).toBe('running:default')
  claude.journal.drain()
  expect(claude.journal.texts()).toEqual([
    'Claude uses Ask for approval instead.',
    'Claude uses Plan mode.'
  ])
  claude.retire()
})

it('waits for the retried history read through a completed resumed turn and skips retired delivery', async () => {
  const earlier = {
    id: `${NOTICE_PREFIX}t00zzzzzzzz:old-process:000001:auto-settings:ask`,
    text: "Claude's settings turn off Approve for me (disableAutoMode), so Claude uses Ask for approval instead.",
    scope: { kind: 'thread' } as const
  }
  const journal = journalRows()
  journal.rows.push(earlier)
  const claude = controlledClaude('auto', journal, false)
  const readStarted = Promise.withResolvers<void>()
  const history = Promise.withResolvers<{ itemId: string; greatestTimedId: string }>()
  const newestItemId = vi
    .fn()
    .mockRejectedValueOnce(new Error('reader replaced'))
    .mockImplementationOnce(() => {
      readStarted.resolve()
      return history.promise
    })
  const seeding = claude.seed({ newestItemId })

  claude.send(report('auto', 'init'))
  claude.frame({
    type: 'assistant',
    session_id: PROVIDER_SESSION,
    uuid: 'resumed-output',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }
  })
  expect(claude.translator.currentTurnId).not.toBeNull()
  claude.frame({ type: 'result', subtype: 'success', session_id: PROVIDER_SESSION, num_turns: 1 })
  expect(claude.translator.currentTurnId).toBeNull()
  await readStarted.promise
  expect(journal.rows).toEqual([earlier])
  const itemId = agentJournalItemKey({ provider: 'orca', clientMessageId: earlier.id })
  history.resolve({ itemId, greatestTimedId: itemId })
  await seeding
  expect(journal.texts()).toEqual([earlier.text, 'Claude uses Approve for me again.'])
  expect(journal.rows[1]?.scope).toEqual({ kind: 'thread' })
  expect(journal.rows[1]!.id > earlier.id).toBe(true)
  expect(newestItemId).toHaveBeenCalledTimes(2)
  claude.retire()

  const restoredId = agentJournalItemKey({ provider: 'orca', clientMessageId: journal.rows[1]!.id })
  const resumed = controlledClaude('auto', journal, false)
  resumed.send(report('auto', 'init'))
  await resumed.seed({
    newestItemId: async () => ({ itemId: restoredId, greatestTimedId: restoredId })
  })
  resumed.retire()

  const retired = controlledClaude('auto', journal, false)
  const lateRead = Promise.withResolvers<{ itemId: string; greatestTimedId: string }>()
  const retiredSeed = retired.seed({ newestItemId: () => lateRead.promise })
  retired.send(report('auto', 'init'))
  retired.retire()
  lateRead.resolve({ itemId, greatestTimedId: itemId })
  await expect(retiredSeed).rejects.toThrow('acquisition retired')
  expect(journal.texts()).toEqual([earlier.text, 'Claude uses Approve for me again.'])
})

it('sorts time-led row IDs across a base-36 digit boundary', async () => {
  const claude = controlledClaude('auto')
  const now = vi.spyOn(Date, 'now').mockReturnValue(36 ** 8 - 1)
  try {
    claude.send(report('default'))
    await Promise.resolve()
    now.mockReturnValue(36 ** 8)
    claude.send(report('auto'))
    await Promise.resolve()
    const [before, after] = claude.journal.rows.map((row) => row.id)
    expect(before).toMatch(/^full-access-refused:claude:t00zzzzzzzz:/)
    expect(after).toMatch(/^full-access-refused:claude:t0100000000:/)
    expect([after, before].sort()).toEqual([before, after])
  } finally {
    now.mockRestore()
    claude.retire()
  }
})
