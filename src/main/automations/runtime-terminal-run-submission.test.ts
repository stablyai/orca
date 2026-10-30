import { appendFileSync } from 'node:fs'
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as transcripts from '../native-chat/transcript-watch'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import {
  createRuntimeAutomationRunTerminalObserver,
  type AutomationRunTerminalHost
} from './runtime-terminal-run-observer'
import type { AutomationRunSubmission } from './run-completion-watcher'
import { buildProfileStateCutoverFixture } from '../persistence/profile-state-cutover-fixture'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})
const line = (raw: unknown) => `${JSON.stringify(raw)}\n`
const codex = (payload: unknown) => line({ type: 'event_msg', payload })
const input = (id: string, root: string, text: string) =>
  codex({
    type: 'item_completed',
    turn_id: root,
    item: { id, type: 'UserMessage', content: [{ type: 'text', text }] }
  })
const answer = (root: string) =>
  codex({ type: 'agent_message', turn_id: root, message: 'CURRENT ANSWER' })

async function fixture(
  agent: 'claude' | 'codex',
  prefix: string,
  options: { submitted?: boolean; atReadStart?: string } = {}
) {
  const submission: AutomationRunSubmission = {
    agent,
    prompt: 'UNIQUE PROMPT',
    submitted: options.submitted ?? false
  }
  const directory = await mkdtemp(join(tmpdir(), 'orca-run-membership-'))
  roots.push(directory)
  const path = join(directory, 'rollout.jsonl')
  await writeFile(path, prefix)
  let caughtUp = 0
  const subscribe = transcripts.subscribeNativeChatTranscript
  vi.spyOn(transcripts, 'subscribeNativeChatTranscript').mockImplementation((args, signal) =>
    subscribe(
      {
        ...args,
        debounceMs: 0,
        reconciliationIntervalMs: 10,
        onRecord: (event) => {
          args.onRecord?.(event)
          if (event.kind === 'read-start' && options.atReadStart && !submission.submitted) {
            submission.submitted = true
            submission.onSubmit?.()
            appendFileSync(path, options.atReadStart)
          }
          if (event.kind === 'caught-up') {
            caughtUp += 1
          }
        }
      },
      signal
    )
  )
  const row = {
    paneKey: 'pane',
    prompt: '',
    stateStartedAt: 1,
    agentType: agent,
    state: 'working',
    receivedAt: 1,
    executionId: 'execution',
    connectionId: null,
    providerSession: { id: 'session', key: 'session_id', transcriptPath: path },
    subagents: [{ id: 'monitor', state: 'working', startedAt: 1 }]
  } satisfies AgentStatusIpcPayload
  let incarnation = 'original'
  const runtime: AutomationRunTerminalHost = {
    getTerminalHandleForPaneKey: () => 'handle',
    getTerminalPromptRequestBinding: () => ({
      ptyId: 'pty',
      processIncarnation: incarnation,
      generation: 1
    }),
    getAgentStatusRowsForPane: () => [row],
    readObservedAgentStatusPaneIdentityFn: () => ({
      kind: 'observed',
      dispatchId: null,
      terminalHandle: 'handle',
      processIncarnation: incarnation
    }),
    readTerminal: async () => ({ tail: ['STALE WAKEUP'] }),
    waitForTerminal: async () => {
      throw new Error('aggregate idle must not judge this prompt')
    }
  }
  const run = {
    ...buildProfileStateCutoverFixture('/fixture').automationRuns[0]!,
    terminalPaneKey: 'pane',
    terminalPtyId: 'pty'
  }
  const controller = new AbortController()
  const pending = createRuntimeAutomationRunTerminalObserver(runtime).observeCompletion('handle', {
    run,
    submission,
    signal: controller.signal
  })
  await vi.waitFor(() => expect(caughtUp).toBeGreaterThan(0))
  if (!submission.submitted) {
    submission.submitted = true
    submission.onSubmit?.()
  }
  return {
    pending,
    controller,
    row,
    path,
    submission,
    replace: () => {
      incarnation = 'replacement'
    }
  }
}

it.each(['queue', 'steer'] as const)(
  'uses committed Codex membership for %s and ignores pre-acceptance hooks',
  async (mode) => {
    const h = await fixture('codex', codex({ type: 'task_started', turn_id: 'T0' }))
    const target = mode === 'queue' ? 'T1' : 'T0'
    try {
      await appendFile(
        h.path,
        codex({ type: 'UserPromptSubmit', turn_id: 'T0', prompt: 'UNIQUE PROMPT' }) +
          (mode === 'queue'
            ? codex({ type: 'task_complete', turn_id: 'T0' }) +
              codex({ type: 'task_started', turn_id: 'T1' })
            : '') +
          input('U', target, 'UNIQUE PROMPT') +
          answer(target) +
          codex({ type: 'task_complete', turn_id: target })
      )
      expect(await h.pending).toMatchObject({
        status: 'completed',
        outputSnapshot: { content: 'CURRENT ANSWER' }
      })
      expect(h.row.state).toBe('working')
      expect(h.row.subagents[0]?.state).toBe('working')
    } finally {
      h.controller.abort()
    }
  }
)

it('joins a composed Claude absorbed attachment through its actual parents and explicit end', async () => {
  // Composed lineage: the recorded queued-prompt fixture proves attachment shape, not this complete chain.
  const h = await fixture(
    'claude',
    line({
      type: 'user',
      sessionId: 'session',
      uuid: 'U0',
      parentUuid: null,
      message: { role: 'user', content: 'start' }
    }) +
      line({
        type: 'assistant',
        sessionId: 'session',
        uuid: 'A0',
        parentUuid: 'U0',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: {} }],
          stop_reason: 'tool_use'
        }
      })
  )
  try {
    await appendFile(
      h.path,
      line({
        type: 'attachment',
        sessionId: 'session',
        uuid: 'U1',
        parentUuid: 'A0',
        attachment: {
          type: 'queued_command',
          prompt: 'UNIQUE PROMPT',
          commandMode: 'prompt',
          origin: { kind: 'human' },
          humanTurn: true
        }
      }) +
        line({
          type: 'assistant',
          sessionId: 'session',
          uuid: 'A1',
          parentUuid: 'U1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'CURRENT ANSWER' }],
            stop_reason: 'end_turn'
          }
        })
    )
    expect(await h.pending).toMatchObject({ status: 'completed' })
    expect(h.row.subagents[0]?.state).toBe('working')
  } finally {
    h.controller.abort()
  }
})

it.each(['replace', 'abort', 'duplicate'] as const)(
  'does not invent a result on %s',
  async (mode) => {
    const h = await fixture('codex', codex({ type: 'task_started', turn_id: 'T0' }))
    if (mode === 'replace') {
      h.replace()
    }
    if (mode === 'abort') {
      h.controller.abort()
    }
    await appendFile(
      h.path,
      input('U1', 'T0', 'UNIQUE PROMPT') +
        input('U2', 'T0', 'UNIQUE PROMPT') +
        codex({ type: 'task_complete', turn_id: 'T0' })
    )
    await expect(h.pending).resolves.toBeNull()
    h.controller.abort()
  }
)

it('retains a real pre-Enter read-start cursor when accepted input and end race that drain', async () => {
  const h = await fixture('codex', codex({ type: 'task_started', turn_id: 'T' }), {
    atReadStart:
      input('U', 'T', 'UNIQUE PROMPT') +
      answer('T') +
      codex({ type: 'task_complete', turn_id: 'T' })
  })
  try {
    await expect(h.pending).resolves.toMatchObject({ status: 'completed' })
  } finally {
    h.controller.abort()
  }
})

it('leaves late initial replay unknown: an old equal occurrence and this send have indistinguishable evidence', async () => {
  const h = await fixture(
    'codex',
    codex({ type: 'task_started', turn_id: 'T' }) +
      input('U', 'T', 'UNIQUE PROMPT') +
      answer('T') +
      codex({ type: 'task_complete', turn_id: 'T' }),
    { submitted: true }
  )
  try {
    await expect(h.pending).resolves.toBeNull()
  } finally {
    h.controller.abort()
  }
})

it('uses Codex native containing turn while preserving a different causal root', async () => {
  const h = await fixture(
    'codex',
    codex({ type: 'task_started', turn_id: 'T1', root_turn_id: 'T0' })
  )
  try {
    await appendFile(
      h.path,
      input('U', 'T1', 'UNIQUE PROMPT') +
        answer('T1') +
        codex({ type: 'task_complete', turn_id: 'T1', root_turn_id: 'T0' })
    )
    await expect(h.pending).resolves.toMatchObject({
      status: 'completed',
      outputSnapshot: { content: 'CURRENT ANSWER' }
    })
  } finally {
    h.controller.abort()
  }
})
