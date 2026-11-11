import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { backgroundTaskBlocks } from '../../shared/native-chat/input/native-chat-background-task-row'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/agent-session-turn-record'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { settleStaleStructuredAgentSessionState } from '../native-chat/agent-session-wire/termination/structured-agent-session-stale-state-settlement'
import { acpLaunchSpecFor } from '../acp/launch/acp-launch-registry'
import type { AcpLaunchSpec } from '../acp/launch/acp-launch-contract'
import { AcpPromptRequest } from '../acp/protocol/acp-prompt-request'
import {
  openAcpAdapterRig,
  PROVIDER_SESSION,
  sendHello,
  waitFor
} from '../acp/session/testing/acp-structured-adapter.test-support'
import { createAntigravityPromptTurnTracker } from './antigravity-prompt-turn-tracker'

const ANTIGRAVITY_HOST: AcpLaunchSpec = {
  ...acpLaunchSpecFor('antigravity')!.hostBackend!.spec,
  turnTracker: (env, now, recoverableTaskIds) =>
    createAntigravityPromptTurnTracker(env, { now, recoverableTaskIds })
}
const folders: string[] = []

afterEach(async () => {
  await closeProviderTimelineRigs()
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it('aborts tracker setup and skips wire request when cancelled during beginPrompt', async () => {
  const prompt = new AcpPromptRequest(false)
  let resolveBegin!: () => void
  const abortPrompt = vi.fn()
  const request = vi.fn(async () => ({ stopReason: 'end_turn' as const }))

  const runPromise = prompt.run(request, {
    attach: () => {},
    beginPrompt: () =>
      new Promise<void>((resolve) => {
        resolveBegin = resolve
      }),
    finishPrompt: async (res) => res,
    abortPrompt,
    beforeNotification: () => true,
    dispose: () => {}
  })

  prompt.cancel()
  resolveBegin()

  await expect(runPromise).resolves.toEqual({ stopReason: 'cancelled' })
  expect(request).not.toHaveBeenCalled()
  expect(abortPrompt).toHaveBeenCalledTimes(1)
})

it('settles backgrounded commands, streams reactive wakeup turns, and drops lagging replay duplicates', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'orca-agy-tracker-test-'))
  folders.push(userHome)
  const geminiHome = join(userHome, '.gemini')
  const sysDir = join(geminiHome, 'antigravity-cli', 'brain', PROVIDER_SESSION, '.system_generated')
  const logsDir = join(sysDir, 'logs')
  const msgDir = join(sysDir, 'messages')
  await mkdir(logsDir, { recursive: true })
  await mkdir(msgDir, { recursive: true })
  const transcriptPath = join(logsDir, 'transcript_full.jsonl')

  let clock = 10_000
  let promptCount = 0

  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY_HOST,
    launch: {
      env: {
        PATH: '/usr/bin',
        HOME: userHome,
        USERPROFILE: userHome,
        GEMINI_HOME: '/unrelated/gemini-home'
      }
    },
    deps: { now: () => clock },
    script: (agent) => {
      agent.on('session/prompt', async (frame) => {
        promptCount += 1
        if (promptCount === 1) {
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_read_1',
              kind: 'read',
              name: 'read_file',
              title: 'read_file',
              status: 'in_progress',
              rawInput: { Path: '/tmp/notes.md' }
            }
          })
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'call_bg_1',
              kind: 'execute',
              title: 'Sleep job',
              status: 'in_progress',
              rawInput: { CommandLine: 'Start-Sleep 5', toolSummary: 'Sleep job' }
            }
          })
          await writeFile(
            transcriptPath,
            [
              JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'hi' }),
              JSON.stringify({
                step_index: 1,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                tool_calls: [
                  {
                    id: 'call_bg_1',
                    name: 'run_command',
                    args: { CommandLine: 'Start-Sleep 5', toolSummary: 'Sleep job' }
                  }
                ]
              }),
              JSON.stringify({
                step_index: 2,
                type: 'GENERIC',
                status: 'RUNNING',
                content:
                  'Created At: 2026-11-10T12:00:00Z\nTool is running as a background task with task id: sess/task-1'
              }),
              JSON.stringify({
                step_index: 3,
                type: 'PLANNER_RESPONSE',
                status: 'DONE',
                content: 'Launched background job.'
              }),
              ''
            ].join('\n')
          )
          agent.notify('session/update', {
            sessionId: PROVIDER_SESSION,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Launched background job.' }
            }
          })
          agent.reply(frame, { stopReason: 'end_turn' })
          return
        }

        // Second prompt replays the reactive turn's message before answering the new prompt.
        agent.notify('session/update', {
          sessionId: PROVIDER_SESSION,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Background job finished cleanly!' }
          }
        })
        agent.notify('session/update', {
          sessionId: PROVIDER_SESSION,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Second prompt answer.' }
          }
        })
        agent.reply(frame, { stopReason: 'end_turn' })
      })
    }
  })

  await rig.acquire()
  await sendHello(rig, 'send-1')

  // Prompt 1 settles the backgrounded launcher tool call immediately (without touching earlier non-exec tools) and records a working background task.
  await waitFor(async () => {
    const rows = await rig.rig.rows()
    const tools = rows.filter((r) => r.body.kind === 'tool-call')
    expect(tools).toHaveLength(2)
    expect(tools[0]?.body).toMatchObject({ kind: 'tool-call', state: 'failed' })
    expect(tools[1]?.body).toMatchObject({ kind: 'tool-call', state: 'completed' })
    const bgBlocks = rows.flatMap((r) =>
      r.body.kind === 'message' ? backgroundTaskBlocks(r.body.blocks) : []
    )
    expect(bgBlocks).toEqual([
      expect.objectContaining({
        taskId: 'sess/task-1',
        state: 'working',
        label: 'Sleep job',
        parentToolUseId: 'call_bg_1'
      })
    ])
  })

  // Now the background task finishes on disk and language_server writes a reactive wakeup turn.
  await writeFile(
    join(msgDir, 'msg-1.json'),
    JSON.stringify({
      sender: 'sess/task-1',
      content: 'Command exited with code 0.\nDone!',
      sourceMetadata: { tool: { stepIndex: 2, toolCall: { id: 'call_bg_1' } } }
    })
  )
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({ step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Background job finished cleanly!'
      }),
      ''
    ].join('\n'),
    { flag: 'a' }
  )

  // Advance clock past transcript mtime + quiet threshold so reactive turn closes cleanly.
  clock = Date.now() + 5_000

  await waitFor(async () => {
    const rows = await rig.rig.rows()
    const bgBlocks = rows.flatMap((r) =>
      r.body.kind === 'message' ? backgroundTaskBlocks(r.body.blocks) : []
    )
    expect(bgBlocks).toEqual([
      expect.objectContaining({
        taskId: 'sess/task-1',
        state: 'done'
      })
    ])
    const assistantTexts = rows
      .filter((r) => r.body.kind === 'message' && r.body.role === 'assistant')
      .flatMap((r) =>
        r.body.kind === 'message' ? r.body.blocks.map((b) => (b.type === 'text' ? b.text : '')) : []
      )
    expect(assistantTexts).toContain('Background job finished cleanly!')
    const turns = rows.flatMap((r) => readAgentJournalTurn(r.body) ?? [])
    expect(turns).toHaveLength(2)
    expect(turns[1]).toMatchObject({ state: 'completed', outcome: 'success' })
  })

  // Send a second user prompt and verify the lagging replay duplicate from agy acp is suppressed!
  await sendHello(rig, 'send-2')
  await waitFor(async () => {
    const rows = await rig.rig.rows()
    const assistantTexts = rows
      .filter((r) => r.body.kind === 'message' && r.body.role === 'assistant')
      .flatMap((r) =>
        r.body.kind === 'message' ? r.body.blocks.map((b) => (b.type === 'text' ? b.text : '')) : []
      )
    expect(assistantTexts).toEqual([
      'Launched background job.',
      'Background job finished cleanly!',
      'Second prompt answer.'
    ])
  })
})

it('accepts ACP tool content arrays, preserves raced wakeups on finishPrompt, and excludes failed prompt steps', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'orca-agy-tracker-edge-'))
  folders.push(userHome)
  const sysDir = join(
    userHome,
    '.gemini',
    'antigravity-cli',
    'brain',
    PROVIDER_SESSION,
    '.system_generated'
  )
  await mkdir(join(sysDir, 'logs'), { recursive: true })
  await mkdir(join(sysDir, 'messages'), { recursive: true })
  const transcriptPath = join(sysDir, 'logs', 'transcript_full.jsonl')

  const emitted: { method: string; params: unknown }[] = []
  let now = 20_000
  const tracker = createAntigravityPromptTurnTracker(
    { HOME: userHome, USERPROFILE: userHome },
    { now: () => now, activePollMs: 50_000 }
  )
  tracker.attach(PROVIDER_SESSION, (method, params) => emitted.push({ method, params }))

  // 1. Prompt 1: tool_call carries ACP `content: [...]` array AND a background wakeup (steps 3..4)
  //    lands on disk before finishPrompt refreshes, alongside a concurrent pollOnce().
  await tracker.beginPrompt()
  expect(
    tracker.beforeNotification('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call_arr_1',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'npm test', toolSummary: 'Run suite' },
        content: [{ type: 'content', content: { type: 'text', text: 'starting' } }]
      }
    })
  ).toBe(true)
  expect(
    tracker.beforeNotification('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Suite backgrounded.' }
      }
    })
  ).toBe(true)

  await writeFile(
    transcriptPath,
    [
      JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'run' }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Suite backgrounded.',
        tool_calls: [{ id: 'call_arr_1', name: 'run_command', args: { CommandLine: 'npm test' } }]
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Tool is running as a background task with task id: sess/task-arr'
      }),
      JSON.stringify({ step_index: 3, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
      JSON.stringify({
        step_index: 4,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Raced wakeup response!',
        tool_calls: [{ id: 'call_raced', name: 'read_file', args: { Path: '/tmp/a.txt' } }]
      }),
      JSON.stringify({ step_index: 5, type: 'GENERIC', status: 'DONE', content: 'file body' }),
      ''
    ].join('\n')
  )

  const concurrentPoll = tracker.pollOnce()
  await tracker.finishPrompt({ stopReason: 'end_turn' })
  await concurrentPoll

  // Launcher with `content: [...]` was tracked & settled, and late updates for it are suppressed.
  expect(
    tracker.beforeNotification('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call_arr_1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'done' } }]
      }
    })
  ).toBe(false)

  // Raced wakeup steps 3..5 were NOT swallowed by finishPrompt!
  const chunkSchema = z.looseObject({
    update: z
      .looseObject({
        sessionUpdate: z.string().optional(),
        content: z.looseObject({ text: z.string().optional() }).optional()
      })
      .optional()
  })
  const reactiveMessages = () =>
    emitted.flatMap((e) => {
      const p = chunkSchema.safeParse(e.params)
      return e.method === 'session/update' &&
        p.success &&
        p.data.update?.sessionUpdate === 'agent_message_chunk'
        ? [p.data.update.content?.text]
        : []
    })
  expect(reactiveMessages()).toEqual(['Raced wakeup response!'])

  // 2. Prompt 2 replays the reactive read_file tool_call with `content: [...]` array -> suppressed,
  //    then emits partial foreground output and FAILS (abortPrompt).
  now = Date.now() + 5_000
  await tracker.beginPrompt()
  expect(
    tracker.beforeNotification('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'replay_read_1',
        kind: 'read',
        name: 'read_file',
        status: 'in_progress',
        rawInput: { Path: '/tmp/a.txt' },
        content: [{ type: 'content', content: { type: 'text', text: 'replayed' } }]
      }
    })
  ).toBe(false)
  expect(
    tracker.beforeNotification('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'replay_read_1',
        status: 'completed',
        content: []
      }
    })
  ).toBe(false)
  expect(
    tracker.beforeNotification('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Partial failed output' }
      }
    })
  ).toBe(true)

  await writeFile(
    transcriptPath,
    [
      JSON.stringify({ step_index: 6, type: 'USER_INPUT', status: 'DONE', content: 'retry' }),
      JSON.stringify({
        step_index: 7,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Partial failed output'
      }),
      ''
    ].join('\n'),
    { flag: 'a' }
  )

  await tracker.abortPrompt()
  await tracker.pollOnce()

  // Failed prompt's partial output must NOT be re-projected as a reactive turn.
  expect(reactiveMessages()).toEqual(['Raced wakeup response!'])

  // 3. Permanently schema-rejected record (step 8) and corrupt JSON gap (step 9 missing before step 10)
  //    recover cleanly without stalling later reactive steps.
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({ step_index: 8, type: 99999 }),
      '{corrupt-json-line',
      JSON.stringify({ step_index: 10, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
      JSON.stringify({
        step_index: 11,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Recovered past rejected records!'
      }),
      ''
    ].join('\n'),
    { flag: 'a' }
  )

  await tracker.pollOnce()
  await tracker.pollOnce()
  expect(reactiveMessages()).toEqual(['Raced wakeup response!', 'Recovered past rejected records!'])
  tracker.dispose()
})

it('reconciles persisted unverifiable background tasks on resume without duplicating historical tasks', async () => {
  const userHome = await mkdtemp(join(tmpdir(), 'orca-agy-tracker-resume-'))
  folders.push(userHome)
  const sysDir = join(
    userHome,
    '.gemini',
    'antigravity-cli',
    'brain',
    PROVIDER_SESSION,
    '.system_generated'
  )
  const logsDir = join(sysDir, 'logs')
  const msgDir = join(sysDir, 'messages')
  await mkdir(logsDir, { recursive: true })
  await mkdir(msgDir, { recursive: true })
  const transcriptPath = join(logsDir, 'transcript_full.jsonl')

  // Historical task `sess/task-unrelated` ran and settled in CLI before Orca ever attached.
  await writeFile(
    transcriptPath,
    [
      JSON.stringify({
        step_index: 0,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'c0', name: 'run_command', args: { CommandLine: 'echo old' } }]
      }),
      JSON.stringify({
        step_index: 1,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Tool is running as a background task with task id: sess/task-unrelated'
      }),
      ''
    ].join('\n')
  )
  await writeFile(
    join(msgDir, 'msg-old.json'),
    JSON.stringify({ sender: 'sess/task-unrelated', content: 'Command exited with code 0.' })
  )

  let resuming = false
  const rig = await openAcpAdapterRig({
    spec: ANTIGRAVITY_HOST,
    deps: {
      resolveLaunch: async () => ({
        spec: ANTIGRAVITY_HOST,
        command: '/opt/bin/agy',
        prefixArgs: [],
        args: ['acp'],
        cwd: '/workspace/project',
        env: { PATH: '/usr/bin', HOME: userHome, USERPROFILE: userHome },
        envToDelete: [],
        fullAccess: false,
        resume: resuming
          ? {
              sessionId: PROVIDER_SESSION,
              key: PROVIDER_SESSION,
              mayBeUnsaved: () => false,
              unannouncedLosses: () => []
            }
          : null
      })
    },
    initialize: {
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }
    },
    script: (agent) => {
      agent.on('session/resume', (frame) => agent.reply(frame, { configOptions: [] }))
      agent.on('session/prompt', async (frame) => {
        agent.notify('session/update', {
          sessionId: PROVIDER_SESSION,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_persist_1',
            kind: 'execute',
            title: 'Long build',
            status: 'in_progress',
            rawInput: { CommandLine: 'pnpm build', toolSummary: 'Long build' }
          }
        })
        await writeFile(
          transcriptPath,
          [
            JSON.stringify({ step_index: 2, type: 'USER_INPUT', status: 'DONE', content: 'build' }),
            JSON.stringify({
              step_index: 3,
              type: 'PLANNER_RESPONSE',
              status: 'DONE',
              tool_calls: [
                {
                  id: 'call_persist_1',
                  name: 'run_command',
                  args: { CommandLine: 'pnpm build', toolSummary: 'Long build' }
                }
              ]
            }),
            JSON.stringify({
              step_index: 4,
              type: 'GENERIC',
              status: 'RUNNING',
              content: 'Tool is running as a background task with task id: sess/task-persisted'
            }),
            ''
          ].join('\n'),
          { flag: 'a' }
        )
        agent.reply(frame, { stopReason: 'end_turn' })
      })
    }
  })

  await rig.acquire({ fence: 1 })
  await sendHello(rig, 'send-build')

  await waitFor(async () => {
    const bgBlocks = (await rig.rig.rows()).flatMap((r) =>
      r.body.kind === 'message' ? backgroundTaskBlocks(r.body.blocks) : []
    )
    expect(bgBlocks).toEqual([
      expect.objectContaining({ taskId: 'sess/task-persisted', state: 'working' })
    ])
  })

  // Disconnect generation 1 so Orca marks `sess/task-persisted` unverifiable, then finish it on disk.
  await rig.adapter.releaseAcquisition({ sessionId: SESSION })
  await settleStaleStructuredAgentSessionState({
    journal: rig.rig.journal,
    sessionId: SESSION,
    fence: 1,
    acquisitionGeneration: 'gen-2',
    deathEvidence: null
  })
  await waitFor(async () => {
    const bgBlocks = (await rig.rig.rows()).flatMap((r) =>
      r.body.kind === 'message' ? backgroundTaskBlocks(r.body.blocks) : []
    )
    expect(bgBlocks).toEqual([
      expect.objectContaining({ taskId: 'sess/task-persisted', state: 'unverifiable' })
    ])
  })

  await writeFile(
    join(msgDir, 'msg-persisted.json'),
    JSON.stringify({
      sender: 'sess/task-persisted',
      content: 'Command exited with code 0.\nBuilt!'
    })
  )

  // Reconnect on resume: `sess/task-persisted` recovers to `done`, and `sess/task-unrelated` is not duplicated.
  resuming = true
  await rig.acquire({ fence: 2 })
  await waitFor(async () => {
    const bgBlocks = (await rig.rig.rows()).flatMap((r) =>
      r.body.kind === 'message' ? backgroundTaskBlocks(r.body.blocks) : []
    )
    expect(bgBlocks).toEqual([
      expect.objectContaining({
        taskId: 'sess/task-persisted',
        state: 'done',
        label: 'Long build'
      })
    ])
  })
})
