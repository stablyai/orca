import { describe, expect, it, vi } from 'vitest'
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { ClaudePromptRegistry } from '../claude-prompt-registry'
import { invokeCanUseTool } from '../claude-can-use-tool-test-support'
import { buildClaudePermissionCallbacks } from './claude-structured-inbound-control'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import { claudeStructuredPermissionOptions } from './launch/claude-structured-launch-resolution'
import {
  adapterFor,
  fakeClaude,
  identityFor,
  PROVIDER_SESSION_ID,
  recordingJournalSink,
  tick,
  type FakeConnection
} from './claude-structured-session-test-support'

type CanUseToolOptions = Parameters<CanUseTool>[2]

function permissionOptions(
  requestId: string,
  toolUseID: string,
  signal: AbortSignal,
  suggestions?: CanUseToolOptions['suggestions'],
  presentation: Partial<CanUseToolOptions> = {}
): CanUseToolOptions {
  return {
    ...presentation,
    requestId,
    toolUseID,
    signal,
    ...(suggestions ? { suggestions } : {})
  }
}

function callbacksFor(fullAccess = false) {
  const prompts = new ClaudePromptRegistry()
  const emit = vi.fn()
  const { canUseTool, onUserDialog } = buildClaudePermissionCallbacks({
    sessionId: 'session-1',
    prompts,
    emit,
    fullAccessAt: () => fullAccess
  })
  return { prompts, emit, canUseTool, onUserDialog }
}

describe('Claude permission callbacks', () => {
  it('registers a decodable can_use_tool as a durable prompt and settles it from the registry', async () => {
    const control = callbacksFor()
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const answered = control.canUseTool(
      'Bash',
      { command: 'git status' },
      permissionOptions('perm-1', 'tool-1', controller.signal, [
        { type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }
      ])
    )

    expect(control.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'prompt',
        sessionId: 'session-1',
        prompt: expect.objectContaining({ promptKey: 'perm-1', toolName: 'Bash', kind: 'approval' })
      })
    )
    const found = control.prompts.find('perm-1')
    expect(found?.prompt.suggestions).toEqual([
      { type: 'addRules', rules: [], behavior: 'allow', destination: 'session' }
    ])
    found?.prompt.settle({ behavior: 'allow', toolUseID: 'tool-1' })
    await expect(answered).resolves.toEqual({ behavior: 'allow', toolUseID: 'tool-1' })
    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('keeps the SDK permission presentation and strips terminal escapes', async () => {
    const control = callbacksFor()
    const answered = control.canUseTool(
      'Read',
      { file_path: '/repo/secrets.txt' },
      permissionOptions(
        'perm-presentation',
        'tool-presentation',
        new AbortController().signal,
        [],
        {
          title: '\u001b[31mClaude wants to read secrets.txt\u001b[0m',
          displayName: 'Read file',
          description: 'Read access outside the workspace',
          decisionReason: '\u001b[33mThe path is outside the allowed root.\u001b[0m',
          blockedPath: '/repo/secrets.txt',
          matchedAskRule: { source: 'project', toolName: 'Read', ruleContent: '/repo/**' }
        }
      )
    )

    const prompt = control.prompts.find('perm-presentation')?.prompt
    expect(prompt).toMatchObject({
      title: 'Claude wants to read secrets.txt',
      displayName: 'Read file',
      description: 'Read access outside the workspace',
      decisionReason: 'The path is outside the allowed root.',
      blockedPath: '/repo/secrets.txt',
      matchedAskRule: { source: 'project', toolName: 'Read', ruleContent: '/repo/**' }
    })
    expect(JSON.stringify(prompt)).not.toContain('\\u001b')
    prompt?.settle({ behavior: 'deny', message: 'done', toolUseID: 'tool-presentation' })
    await expect(answered).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('classifies a plan before generic permission registration', async () => {
    const control = callbacksFor()
    const register = vi.spyOn(control.prompts, 'register')
    const answered = control.canUseTool(
      'ExitPlanMode',
      { plan: '# Release\n\n- Run tests', planFilePath: '/repo/plan.md' },
      permissionOptions('perm-plan', 'tool-plan', new AbortController().signal)
    )

    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: { kind: 'plan', text: '# Release\n\n- Run tests', filePath: '/repo/plan.md' }
      })
    )
    const prompt = control.prompts.find('perm-plan')?.prompt
    expect(prompt?.subject?.kind).toBe('plan')
    prompt?.settle({ behavior: 'deny', message: 'done', toolUseID: 'tool-plan' })
    await expect(answered).resolves.toMatchObject({ behavior: 'deny' })
  })

  it('denies a malformed permission request without registering a prompt', async () => {
    const control = callbacksFor()
    const answered = control.canUseTool(
      '',
      {},
      permissionOptions('perm-2', 'tool-2', new AbortController().signal)
    )

    await expect(answered).resolves.toEqual({
      behavior: 'deny',
      message: 'Orca could not decode this permission request.',
      toolUseID: 'tool-2'
    })
    expect(control.prompts.find('perm-2')).toBeNull()
    expect(control.emit).not.toHaveBeenCalled()
  })

  it('settles a pending prompt with null and forgets it when the abort signal fires', async () => {
    const control = callbacksFor()
    const controller = new AbortController()
    const answered = control.canUseTool(
      'Bash',
      { command: 'ls' },
      permissionOptions('perm-3', 'tool-3', controller.signal)
    )
    expect(control.prompts.find('perm-3')).not.toBeNull()

    controller.abort()

    await expect(answered).resolves.toBeNull()
    expect(control.emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'prompt-cancelled', promptKey: 'perm-3' })
    )
    expect(control.prompts.find('perm-3')).toBeNull()
  })

  it('cancels a request whose abort raced ahead of delivery without emitting a prompt', async () => {
    const control = callbacksFor()
    const controller = new AbortController()
    controller.abort()

    const answered = control.canUseTool(
      'Bash',
      { command: 'ls' },
      permissionOptions('perm-4', 'tool-4', controller.signal)
    )

    await expect(answered).resolves.toBeNull()
    expect(control.prompts.find('perm-4')).toBeNull()
    expect(control.emit).toHaveBeenCalledTimes(1)
    expect(control.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'prompt-cancelled', promptKey: 'perm-4' })
    )
  })

  it('still asks for questions, plan approval and interaction-flagged tools in Full access', () => {
    const control = callbacksFor(true)
    void control.canUseTool(
      'AskUserQuestion',
      { questions: [{ question: 'Which?', header: 'Pick', options: [], multiSelect: false }] },
      permissionOptions('q', 'tool-q', new AbortController().signal)
    )
    void control.canUseTool(
      'ExitPlanMode',
      { plan: '# Plan' },
      permissionOptions('p', 'tool-p', new AbortController().signal)
    )
    // The SDK passes the CLI's requires_user_interaction through, outside its declared type.
    const flagged = { title: 'Confirm your answer', requiresUserInteraction: true }
    void control.canUseTool(
      'mcp__forms__confirm',
      { request: 'Please enter your answer' },
      permissionOptions('m', 'tool-m', new AbortController().signal, [], flagged)
    )
    expect(control.prompts.find('q')).not.toBeNull()
    expect(control.prompts.find('p')).not.toBeNull()
    expect(control.prompts.find('m')).not.toBeNull()
  })
})

// The recorded Claude Code 2.1.310 safety-check ask under --dangerously-skip-permissions.
const SAFETY_CHECK =
  'Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed'
const SHELL_INPUT = {
  command: 'for v in HOME PATH; do echo "${(P)v}" | head -c 5; done',
  description: 'Print the start of HOME and PATH'
}

type WireItem = Record<string, unknown>

const modeFrame = (subtype: 'init' | 'status', permissionMode?: unknown): WireItem => ({
  type: 'system',
  subtype,
  ...(subtype === 'status' ? { status: null } : {}),
  ...(permissionMode === undefined ? {} : { permissionMode }),
  session_id: PROVIDER_SESSION_ID
})
const ask = (id: string): WireItem => ({
  type: 'control_request',
  request_id: id,
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    input: SHELL_INPUT,
    tool_use_id: `tool-${id}`,
    decision_reason: SAFETY_CHECK
  }
})
const allowed = (id: string) => ({
  behavior: 'allow',
  updatedInput: SHELL_INPUT,
  toolUseID: `tool-${id}`
})

function askFor(connection: FakeConnection, id: string) {
  return invokeCanUseTool(connection, 'Bash', id, `tool-${id}`, {
    input: SHELL_INPUT,
    decisionReason: SAFETY_CHECK
  })
}

async function outcome(request: ReturnType<typeof askFor>): Promise<unknown> {
  await tick()
  return request.settled() ? request.promise : 'card'
}

/** One stdout chunk, then each request in it, as the SDK asks only after reading the whole chunk. */
function writeWire(connection: FakeConnection, wire: WireItem[]) {
  connection.handlers.onStdout?.(wire.map((frame) => `${JSON.stringify(frame)}\n`).join(''))
  return wire.flatMap((frame) =>
    frame.type === 'control_request' ? [askFor(connection, String(frame.request_id))] : []
  )
}

function overWire(connection: FakeConnection, wire: WireItem[]) {
  return Promise.all(writeWire(connection, wire).map(outcome))
}

function cards(events: ClaudeStructuredSessionEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'prompt' ? [event.prompt.promptKey] : []))
}

async function acquireWith(
  choice: Parameters<typeof claudeStructuredPermissionOptions>[0],
  events: ClaudeStructuredSessionEvent[],
  beforePublish?: (connection: FakeConnection) => void
): Promise<FakeConnection> {
  const claude = fakeClaude()
  const adapter = adapterFor(
    {
      ...claude,
      openConnection: async (launch, handlers) => {
        const connection = await claude.openConnection(launch, handlers)
        beforePublish?.(claude.connections.at(-1)!)
        return connection
      }
    },
    { options: claudeStructuredPermissionOptions(choice) },
    events
  )
  await adapter.acquire({
    identity: identityFor(),
    fence: 7,
    spawnToken: 'spawn-9',
    events: recordingJournalSink()
  })
  return claude.connections.at(-1)!
}

describe('Full access through a Claude process', () => {
  it("approves Claude's own asks only while the mode before each request is Full access", async () => {
    const events: ClaudeStructuredSessionEvent[] = []
    let early: ReturnType<typeof askFor> | undefined
    const connection = await acquireWith('full-access', events, (opened) => {
      early = writeWire(opened, [ask('before-publish')])[0]
    })
    await expect(outcome(early!)).resolves.toEqual(allowed('before-publish'))
    // A request Orca never saw on stdout has no position to inherit Full access from.
    await expect(outcome(askFor(connection, 'unseen'))).resolves.toBe('card')

    const table: [string, WireItem[], unknown[]][] = [
      ['before any report', [ask('first')], [allowed('first')]],
      [
        'init bypassPermissions',
        [modeFrame('init', 'bypassPermissions'), ask('init')],
        [allowed('init')]
      ],
      ['status default', [modeFrame('status', 'default'), ask('default')], ['card']],
      ['a status without a mode', [modeFrame('status'), ask('absent')], ['card']],
      [
        'a later bypassPermissions',
        [modeFrame('status', 'bypassPermissions'), ask('back')],
        [allowed('back')]
      ],
      ...['plan', null, 'dontAsk', 'someFutureMode'].map(
        (mode): [string, WireItem[], unknown[]] => [
          `${mode} then bypassPermissions in one chunk`,
          [
            modeFrame('status', mode),
            ask(`in-${mode}`),
            modeFrame('status', 'bypassPermissions'),
            ask(`after-${mode}`)
          ],
          ['card', allowed(`after-${mode}`)]
        ]
      )
    ]
    for (const [label, wire, expected] of table) {
      expect(await overWire(connection, wire), label).toEqual(expected)
    }
    expect(cards(events)).toEqual([
      'unseen',
      'default',
      'absent',
      'in-plan',
      'in-null',
      'in-dontAsk',
      'in-someFutureMode'
    ])
  })

  it.each(['own', 'ask'] as const)(
    'keeps the card in a %s chat even when Claude reports bypassPermissions',
    async (choice) => {
      const events: ClaudeStructuredSessionEvent[] = []
      const connection = await acquireWith(choice, events)
      expect(
        await overWire(connection, [modeFrame('init', 'bypassPermissions'), ask('r')])
      ).toEqual(['card'])
      expect(cards(events)).toEqual(['r'])
    }
  )
})
