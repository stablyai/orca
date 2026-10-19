// GitHub Copilot CLI's recorded `--acp --stdio` traffic (CLI 1.0.98, macOS arm64), replayed through
// the real adapter. Every frame translates through the generic dialect: the captures proved
// Copilot needs no dialect of its own.

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import { parseCliVersion } from '../../shared/app-version'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { acpLaunchSpecFor } from './acp-launch-specs'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  waitFor,
  type AcpAdapterRig
} from './acp-structured-adapter.test-support'
import { GrokFixtureReplay } from './acp-structured-fixture-replay.test-support'
import { readAcpFixture, type AcpFixtureFrame } from './acp-timeline-fixture.test-support'
import {
  InitializeResponseSchema,
  NewSessionResponseSchema,
  PromptRequestSchema,
  SessionNotificationSchema
} from './generated/acp-protocol.generated'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const COPILOT = acpLaunchSpecFor('copilot')!

/** The captured `--version` output verbatim; its sentence-ending period is what the version parser must accept. */
const COPILOT_VERSION_OUTPUT = `GitHub Copilot CLI 1.0.98.
Run 'copilot update' to check for updates.`

/** Curated excerpt of the captured 341-line `--help`: the facts the launch row and sign-in draw on. */
const COPILOT_HELP_FACTS = [
  'login        Authenticate with Copilot',
  '--acp  Start as Agent Client Protocol server',
  '--no-auto-update  Disable downloading CLI updates automatically.',
  '--allow-all  Enable all permissions (equivalent to --allow-all-tools',
  '--additional-mcp-config <json>  Additional MCP servers configuration as JSON string or file',
  'COPILOT_HOME: override the directory where configuration and state files are stored',
  'COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN (in order of precedence)',
  'COPILOT_ALLOW_ALL: allow all tools to run automatically without confirmation'
] as const

const ask = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

async function turns(rig: AcpAdapterRig) {
  return (await rig.rig.rows()).flatMap((row) => readAgentJournalTurn(row.body) ?? [])
}

async function answers(rig: AcpAdapterRig): Promise<string[]> {
  const rows = await rig.rig.rows()
  return rows.flatMap((row) =>
    row.body.kind === 'message' && row.body.role === 'assistant'
      ? [row.body.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('')]
      : []
  )
}

async function toolRows(rig: AcpAdapterRig) {
  const rows = await rig.rig.rows()
  return rows.flatMap((row) => (row.body.kind === 'tool-call' ? [row.body] : []))
}

function recordedPrompt(frames: AcpFixtureFrame[], id: number): string {
  const frame = frames.find((entry) => entry.direction === 'out' && entry.message.id === id)
  const params = PromptRequestSchema.parse(frame?.message.params)
  const block = params.prompt[0]
  if (block?.type !== 'text') {
    throw new Error(`recording ${id} does not open with text`)
  }
  return block.text
}

async function replaying(name: string, options: { fullAccess?: boolean } = {}) {
  const frames = await readAcpFixture(name)
  const replay = new GrokFixtureReplay(frames)
  const rig = await openAcpAdapterRig({
    spec: COPILOT,
    ...(options.fullAccess === true ? { launch: { fullAccess: true } } : {}),
    script: (agent) => replay.attach(agent)
  })
  await rig.acquire()
  return { rig, replay, frames }
}

async function pendingCard(
  rig: AcpAdapterRig,
  replay: GrokFixtureReplay
): Promise<AgentJournalRenderItem> {
  return waitFor(async () => {
    const rows = await rig.rig.rows()
    const found = rows.find(
      (row) => row.body.kind === 'approval' && row.body.resolution.state === 'pending'
    )
    if (!found || replay.awaiting !== 'reply') {
      throw new Error('no pending approval yet')
    }
    return found
  })
}

async function choose(
  rig: AcpAdapterRig,
  row: AgentJournalRenderItem,
  optionId: string
): Promise<void> {
  const body = row.body
  if (body.kind !== 'approval') {
    throw new Error(`item ${row.itemId} is not an approval`)
  }
  const identity = parseAgentJournalItemKey(row.itemId)
  if (!identity) {
    throw new Error(`item ${row.itemId} is not a well-formed item key`)
  }
  await rig.adapter.answerPrompt({
    sessionId: SESSION,
    itemId: row.itemId,
    kind: 'approval',
    response: { kind: 'option', optionId },
    fence: 1,
    // The write the real host commits before the agent hears the answer.
    commit: async () => {
      await rig.rig.journal.appendItem(
        identity,
        {
          ...body,
          resolution: {
            state: 'resolved',
            selectedOptionId: optionId,
            resolvedBy: 'person',
            resolvedAt: 5_000
          }
        },
        { fence: 1, turnScope: row.turnScope ?? { kind: 'thread' } }
      )
    }
  })
}

function permissionAnswers(rig: AcpAdapterRig) {
  return rig
    .child()
    .agent.frames.filter((frame) => frame.method === undefined && frame.result !== undefined)
}

describe('Copilot recordings through the adapter', () => {
  it('brings up the captured fresh-install handshake and reports its own commands', async () => {
    const frames = await readAcpFixture('copilot-v1-handshake')
    const initialized = InitializeResponseSchema.parse(
      frames.find((frame) => frame.direction === 'in' && frame.message.id === 1)?.message.result
    )
    const sessionNew = NewSessionResponseSchema.parse(
      frames.find((frame) => frame.direction === 'in' && frame.message.id === 2)?.message.result
    )
    const commandsNotification = SessionNotificationSchema.parse(
      frames.find((frame) => frame.message.method === 'session/update')?.message.params
    )
    const rig = await openAcpAdapterRig({
      spec: COPILOT,
      initialize: initialized,
      script: (agent) => agent.on('session/new', (frame) => agent.reply(frame, sessionNew))
    })
    await rig.acquire()
    expect(rig.sent('initialize')[0]?.params).toEqual(frames[0]?.message.params)
    expect(rig.sent('session/new')[0]?.params).toEqual(frames[3]?.message.params)
    expect(initialized.agentInfo).toMatchObject({ name: 'Copilot', version: '1.0.98' })
    expect(initialized.authMethods?.map((method) => method.id)).toEqual(['copilot-login'])
    expect(rig.sent('authenticate')).toEqual([])
    expect(rig.started().link).toMatchObject({
      handle: { transport: 'acp', agent: 'copilot', nativeId: 'session-1' },
      origin: 'created'
    })
    expect(
      rig
        .child()
        .agent.frames.filter((frame) => frame.method !== undefined)
        .map((frame) => frame.method)
    ).toEqual(['initialize', 'session/new'])
    expect(rig.adapter.readCommands(SESSION)).toBeUndefined()
    expect(commandsNotification.update.sessionUpdate).toBe('available_commands_update')
    rig.child().agent.notify('session/update', commandsNotification)
    await waitFor(() => expect(rig.adapter.readCommands(SESSION)).toHaveLength(27))
    const commands = rig.adapter.readCommands(SESSION) ?? []
    expect(commands.map((command) => command.name)).toEqual([
      'allow-all',
      'permissions',
      'autopilot',
      'compact',
      'blame',
      'chronicle',
      'context',
      'cwd',
      'fleet',
      'init',
      'list-dirs',
      'mcp',
      'memory',
      'model',
      'plan',
      'plugin',
      'rename',
      'research',
      'remote',
      'reset-allowed-tools',
      'review',
      'sandbox',
      'security-review',
      'session',
      'share',
      'subconscious',
      'usage'
    ])
    expect(commands).toContainEqual({
      name: 'compact',
      kind: 'command',
      description:
        'Summarize conversation history to reduce context window usage. Optionally provide focus instructions.',
      argumentHint: 'focus instructions'
    })
  })

  it('keeps the captured auth-required frame as the not-signed-in verdict', async () => {
    const frames = await readAcpFixture('copilot-v1-auth-required')
    const initialized = InitializeResponseSchema.parse(
      frames.find((frame) => frame.direction === 'in' && frame.message.id === 1)?.message.result
    )
    const refusal = z
      .object({ code: z.number(), message: z.string() })
      .parse(frames.at(-1)?.message.error)
    expect(refusal).toEqual({ code: -32000, message: 'Authentication required' })
    const rig = await openAcpAdapterRig({
      spec: COPILOT,
      initialize: initialized,
      script: (agent) =>
        agent.on('session/new', (frame) => agent.fail(frame, refusal.code, refusal.message))
    })
    await rig.acquire()
    // The standard auth-required code, so the shared mapping refuses the chat as signed out.
    expect(rig.openFailure()).toBeInstanceOf(AgentSessionAcquisitionRefusal)
    expect(rig.openFailure()).toMatchObject({ reason: 'notSignedIn' })
    expect(rig.sent('session/new')).toHaveLength(1)
    expect(rig.sent('authenticate')).toEqual([])
  })

  it('replays the captured prompt turn and keeps the config it moved to', async () => {
    const frames = await readAcpFixture('copilot-v1-prompt-turn')
    const replay = new GrokFixtureReplay(frames)
    const rig = await openAcpAdapterRig({
      spec: COPILOT,
      script: (agent) => replay.attach(agent)
    })
    await rig.acquire()
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask('Reply with exactly the word PONG and nothing else.'),
      fence: 1
    })
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    const recordedAnswer = frames
      .flatMap((frame) => {
        const parsed = SessionNotificationSchema.safeParse(frame.message.params)
        const update = parsed.data?.update
        return update?.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
          ? [update.content.text]
          : []
      })
      .join('')
    expect(recordedAnswer).toBe('PONG')
    expect((await answers(rig)).join('')).toBe(recordedAnswer)
    // The turn itself moved the session off its handshake model, as the capture shows.
    const options = await rig.adapter.readOptions({ sessionId: SESSION, fence: 1 })
    expect(options.current).toMatchObject({ model: 'gpt-6-luna', effort: 'medium' })
  })

  it('asks the person for each tool, and the turn runs once both are allowed', async () => {
    const { rig, replay, frames } = await replaying('copilot-v1-permission-turn')
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask(recordedPrompt(frames, 3)),
      fence: 1
    })
    const shell = await pendingCard(rig, replay)
    expect(shell.body).toMatchObject({
      kind: 'approval',
      title: 'Run the requested shell command',
      options: [
        { id: 'allow_once', label: 'Allow once' },
        { id: 'allow_always', label: 'Always allow' },
        { id: 'reject_once', label: 'Deny' }
      ]
    })
    await choose(rig, shell, 'allow_once')
    const edit = await pendingCard(rig, replay)
    expect(edit.body).toMatchObject({ kind: 'approval', title: 'Update file' })
    await choose(rig, edit, 'allow_once')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    expect(await answers(rig)).toEqual(['DONE'])
    // The read ran unprompted; only the shell command and the patch asked, as the capture shows.
    expect(await toolRows(rig)).toMatchObject([
      {
        name: 'Run the requested shell command',
        state: 'completed',
        input: { command: 'printf shell-ok' },
        output: { head: 'shell-ok\n<shellId: 0 completed with exit code 0>' }
      },
      { name: 'Viewing /workspace/project/notes.txt', state: 'completed' },
      { name: 'apply_patch', state: 'completed' }
    ])
    expect((await rig.rig.rows()).filter((row) => row.body.kind === 'diff')).toMatchObject([
      { body: { kind: 'diff', path: '/workspace/project/notes.txt' } }
    ])
  })

  it('answers each permission itself under full access, with no card shown', async () => {
    const { rig, replay, frames } = await replaying('copilot-v1-permission-turn', {
      fullAccess: true
    })
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask(recordedPrompt(frames, 3)),
      fence: 1
    })
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    expect((await rig.rig.rows()).some((row) => row.body.kind === 'approval')).toBe(false)
    expect(permissionAnswers(rig)).toEqual([
      {
        jsonrpc: '2.0',
        id: 0,
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } }
      },
      {
        jsonrpc: '2.0',
        id: 1,
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } }
      }
    ])
    expect(await answers(rig)).toEqual(['DONE'])
  })

  it('leaves a tool the person denied failed, and the captured turn ends anyway', async () => {
    const { rig, replay, frames } = await replaying('copilot-v1-permission-denied')
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask(recordedPrompt(frames, 3)),
      fence: 1
    })
    const shell = await pendingCard(rig, replay)
    await choose(rig, shell, 'reject_once')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    // The CLI kept its own reason for the failed call, and the model said nothing else.
    const [tool] = await toolRows(rig)
    expect(tool).toMatchObject({ name: 'Run the requested shell command', state: 'failed' })
    expect(tool?.output?.head).toContain('The user rejected this tool call.')
    expect(await answers(rig)).toEqual([])
    // Orca forwarded the person's deny as the offered reject option, not a bare cancel.
    expect(permissionAnswers(rig)).toEqual([
      {
        jsonrpc: '2.0',
        id: 0,
        result: { outcome: { outcome: 'selected', optionId: 'reject_once' } }
      }
    ])
    expect((await rig.rig.rows()).find((row) => row.body.kind === 'approval')?.body).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'reject_once' }
    })
  })

  it.each([
    ['copilot-v1-outside-write', 'DONE'],
    ['copilot-v1-url-fetch', 'Example Domain']
  ])('runs %s to the end under full access, as the captured client did', async (name, answer) => {
    const { rig, replay, frames } = await replaying(name, { fullAccess: true })
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask(recordedPrompt(frames, 3)),
      fence: 1
    })
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    expect(await answers(rig)).toEqual([answer])
    expect((await rig.rig.rows()).some((row) => row.body.kind === 'approval')).toBe(false)
    if (name === 'copilot-v1-outside-write') {
      expect(permissionAnswers(rig)).toEqual([
        {
          jsonrpc: '2.0',
          id: 0,
          result: { outcome: { outcome: 'selected', optionId: 'allow_once' } }
        },
        {
          jsonrpc: '2.0',
          id: 1,
          result: { outcome: { outcome: 'selected', optionId: 'allow_once' } }
        }
      ])
      expect((await rig.rig.rows()).filter((row) => row.body.kind === 'diff')).toMatchObject([
        { body: { kind: 'diff', path: '/workspace/outside/created-by-copilot.txt' } }
      ])
      expect(await toolRows(rig)).toMatchObject([
        { name: 'apply_patch', state: 'completed' },
        { name: 'Write exact text without newline and verify length', state: 'completed' }
      ])
    } else {
      expect(permissionAnswers(rig)).toEqual([
        {
          jsonrpc: '2.0',
          id: 0,
          result: { outcome: { outcome: 'selected', optionId: 'allow_once' } }
        }
      ])
      const [tool] = await toolRows(rig)
      expect(tool).toMatchObject({ name: 'Fetching https://example.com/', state: 'completed' })
      expect(tool?.output?.head).toContain('Contents of https://example.com/:')
    }
  })

  it('finishes the tool a Stop interrupted, ends the turn cancelled, and keeps the session', async () => {
    const { rig, replay, frames } = await replaying('copilot-v1-stop')
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask(recordedPrompt(frames, 3)),
      fence: 1
    })
    const shell = await pendingCard(rig, replay)
    await choose(rig, shell, 'allow_once')
    await waitFor(() => expect(replay.awaiting).toBe('session/cancel'))
    await expect(rig.adapter.cancelTurn({ sessionId: SESSION, fence: 1 })).resolves.toEqual({
      cancelled: true
    })
    // The CLI answers the cancel a request it does not know, finishes the running command, and
    // only then settles the prompt cancelled. The answer is that it takes no such request.
    await waitFor(() => expect(replay.awaiting).toBe('session/prompt'))
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'interrupted', outcome: 'cancellation' }])
    )
    expect(await toolRows(rig)).toMatchObject([
      { name: 'Run requested sleep command', state: 'completed' }
    ])
    // The same session took the follow-up the capture sent after the cancel.
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-2',
      body: ask(recordedPrompt(frames, 5)),
      fence: 1
    })
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([
        { state: 'interrupted', outcome: 'cancellation' },
        { state: 'completed', outcome: 'success' }
      ])
    )
    expect(await answers(rig)).toEqual(['DONE', 'AFTER'])
  })

  it('reattaches what a loaded session replayed without drawing it, and answers from memory', async () => {
    const frames = await readAcpFixture('copilot-v1-reattach')
    const replay = new GrokFixtureReplay(frames)
    const rig = await openAcpAdapterRig({
      spec: COPILOT,
      launch: {
        resume: {
          sessionId: PROVIDER_SESSION,
          key: 'acp:copilot:saved',
          mayBeUnsaved: () => false,
          unannouncedLosses: () => []
        }
      },
      script: (agent) => replay.attach(agent)
    })
    await rig.acquire()
    await rig.settle()
    expect(rig.sent('session/load')).toHaveLength(1)
    expect(rig.sent('session/new')).toHaveLength(0)
    // The exchange the load replayed is history: no user bubble and no reply row appear.
    expect((await rig.rig.rows()).some((row) => row.body.kind === 'message')).toBe(false)
    // The commands it announced (before and after its own reply) survive the load.
    await waitFor(() => expect(rig.adapter.readCommands(SESSION)).toHaveLength(27))
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask(recordedPrompt(frames, 3)),
      fence: 1
    })
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    expect(await answers(rig)).toEqual(['BANANA'])
  })

  it('shows the captured subagent as its own tool rows and its report as the turn answer', async () => {
    const { rig, replay, frames } = await replaying('copilot-v1-subagent-task')
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask(recordedPrompt(frames, 3)),
      fence: 1
    })
    const child = await pendingCard(rig, replay)
    await choose(rig, child, 'allow_once')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    // The parent's task and the child's own command are ordinary tool rows. The child's report and
    // the parent's DONE are anonymous text, which the generic dialect splits at the parent tool's
    // completion into two answer rows.
    expect(await toolRows(rig)).toMatchObject([
      {
        name: 'Print child confirmation',
        state: 'completed',
        input: { agent_type: 'task', name: 'child command', mode: 'sync' }
      },
      {
        name: 'Run requested printf command',
        state: 'completed',
        input: { command: 'printf child-ok' }
      }
    ])
    expect(await answers(rig)).toEqual(['child-ok', 'DONE'])
  })

  it('shows the captured MCP tool call and its output as an ordinary tool row', async () => {
    const { rig, replay, frames } = await replaying('copilot-v1-mcp-tool')
    await rig.adapter.dispatch({
      sessionId: SESSION,
      clientMessageId: 'send-1',
      body: ask(recordedPrompt(frames, 3)),
      fence: 1
    })
    const tool = await pendingCard(rig, replay)
    expect(tool.body).toMatchObject({ kind: 'approval', title: 'echo' })
    await choose(rig, tool, 'allow_once')
    await waitFor(() => expect(replay.awaiting).toBeNull())
    await waitFor(async () =>
      expect(await turns(rig)).toMatchObject([{ state: 'completed', outcome: 'success' }])
    )
    // Copilot loads its own MCP servers though Orca sends none: the call arrives as a tool call
    // whose title is the server's tool, and its output is the capture's echo.
    const [echo] = await toolRows(rig)
    expect(echo).toMatchObject({
      name: 'u4probe-echo',
      state: 'completed',
      input: { text: 'PING-MCP' }
    })
    expect(echo?.output?.head).toContain('MCP-ECHO:{"text":"PING-MCP"}')
    expect(await answers(rig)).toEqual(['MCP-ECHO:{"text":"PING-MCP"}'])
  })

  it('retains the captured CLI facts the version parser and launch row draw on', () => {
    expect(parseCliVersion(COPILOT_VERSION_OUTPUT)).toBe('1.0.98')
    const help = COPILOT_HELP_FACTS.join('\n')
    expect(help).toContain('Start as Agent Client Protocol server')
    expect(help).toContain('in order of precedence')
  })
})
