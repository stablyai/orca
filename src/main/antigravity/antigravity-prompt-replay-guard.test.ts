import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { PROVIDER_SESSION } from '../acp/session/testing/acp-structured-adapter.test-support'
import { createAntigravityPromptTurnTracker } from './antigravity-prompt-turn-tracker'

const folders: string[] = []

afterEach(async () => {
  await Promise.all(folders.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createBrainHome(): Promise<{
  userHome: string
  sysDir: string
  compactPath: string
  fullPath: string
}> {
  const userHome = await mkdtemp(join(tmpdir(), 'orca-agy-replay-guard-'))
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
  return {
    userHome,
    sysDir,
    compactPath: join(sysDir, 'logs', 'transcript.jsonl'),
    fullPath: join(sysDir, 'logs', 'transcript_full.jsonl')
  }
}

const chunkSchema = z.looseObject({
  update: z
    .looseObject({
      sessionUpdate: z.string().optional(),
      toolCallId: z.string().optional(),
      status: z.string().optional(),
      content: z.looseObject({ text: z.string().optional() }).optional()
    })
    .optional()
})

const bgSchema = z.looseObject({
  end: z.looseObject({ stopReason: z.string().optional() }).optional(),
  backgroundTasks: z
    .array(
      z.looseObject({
        taskId: z.string().optional(),
        label: z.string().optional(),
        state: z.string().optional(),
        outputFile: z.string().optional()
      })
    )
    .optional()
})

it('preserves pending reactive tools across beginPrompt, registers wire-settled launchers and multi-call labels, keeps partially delivered wakeups, and stabilizes indexless compact-to-full switches', async () => {
  const { userHome, compactPath, fullPath } = await createBrainHome()

  await writeFile(
    compactPath,
    [
      JSON.stringify({ type: 'USER_INPUT', status: 'DONE', content: 'boot' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Initial reply.' }),
      ''
    ].join('\n')
  )

  const emitted: { method: string; params: unknown }[] = []
  const tracker = createAntigravityPromptTurnTracker(
    { HOME: userHome, USERPROFILE: userHome },
    { now: () => 50_000, activePollMs: 50_000 }
  )
  tracker.attach(PROVIDER_SESSION, (method, params) => emitted.push({ method, params }))
  await tracker.pollOnce()

  await writeFile(
    fullPath,
    [
      JSON.stringify({ type: 'USER_INPUT', status: 'DONE', content: 'boot' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Initial reply.' }),
      JSON.stringify({ step_index: 2, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'rc1', name: 'read_file', args: { Path: '/tmp/reactive.txt' } }]
      }),
      ''
    ].join('\n')
  )
  await tracker.pollOnce()

  const emittedTexts = () =>
    emitted.flatMap((e) => {
      const p = chunkSchema.safeParse(e.params)
      return e.method === 'session/update' &&
        p.success &&
        p.data.update?.sessionUpdate === 'agent_message_chunk'
        ? [p.data.update.content?.text]
        : []
    })
  expect(emittedTexts()).toEqual([])

  await tracker.beginPrompt()
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'wire_cmd_a',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'echo a', toolSummary: 'Job A' }
    }
  })
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'tool_call_update', toolCallId: 'wire_cmd_a', status: 'completed' }
  })
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'wire_cmd_b',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'echo b', toolSummary: 'Job B' }
    }
  })
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Wakeup thought' }
    }
  })

  await writeFile(
    fullPath,
    [
      JSON.stringify({ step_index: 4, type: 'GENERIC', status: 'DONE', content: 'reactive body' }),
      JSON.stringify({ step_index: 5, type: 'USER_INPUT', status: 'DONE', content: 'go' }),
      JSON.stringify({
        step_index: 6,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          {
            id: 'c_a',
            name: 'run_command',
            args: { CommandLine: 'echo a', toolSummary: 'Job A' }
          },
          {
            id: 'c_b',
            name: 'run_command',
            args: { CommandLine: 'echo b', toolSummary: 'Job B' }
          }
        ]
      }),
      JSON.stringify({
        step_index: 7,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Tool is running as a background task with task id: sess/task-a'
      }),
      JSON.stringify({
        step_index: 8,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Tool is running as a background task with task id: sess/task-b'
      }),
      JSON.stringify({ step_index: 9, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
      JSON.stringify({
        step_index: 10,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        thinking: 'Wakeup thought',
        content: 'Wakeup body'
      }),
      ''
    ].join('\n'),
    { flag: 'a' }
  )

  await tracker.finishPrompt({ stopReason: 'end_turn' })

  expect(
    emitted.some((e) => {
      const p = chunkSchema.safeParse(e.params)
      return (
        p.success &&
        p.data.update?.sessionUpdate === 'tool_call_update' &&
        p.data.update.toolCallId === 'agy_bg_step_3_0' &&
        p.data.update.status === 'completed'
      )
    })
  ).toBe(true)

  const bgUpdates = emitted.flatMap((e) => {
    const p = bgSchema.safeParse(e.params)
    return e.method === '_agy/turn_update' && p.success ? (p.data.backgroundTasks ?? []) : []
  })
  expect(bgUpdates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ taskId: 'sess/task-a', label: 'Job A', state: 'working' }),
      expect.objectContaining({ taskId: 'sess/task-b', label: 'Job B', state: 'working' })
    ])
  )
  expect(emittedTexts()).toEqual(['Wakeup body'])
  tracker.dispose()
})

it('handles rejected GENERIC results, aborted launchers, sanitized task paths, matching foreground commands, and long turns', async () => {
  const { userHome, sysDir, fullPath } = await createBrainHome()
  await writeFile(
    fullPath,
    `${JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'init' })}\n`
  )
  let nowMs = 1_000
  const emitted: { method: string; params: unknown }[] = []
  const tracker = createAntigravityPromptTurnTracker(
    { HOME: userHome, USERPROFILE: userHome },
    { activePollMs: 60_000, reactiveQuietDoneMs: 500, now: () => nowMs }
  )
  tracker.attach(PROVIDER_SESSION, (method, params) => emitted.push({ method, params }))
  await tracker.pollOnce()
  emitted.length = 0

  await writeFile(
    fullPath,
    [
      JSON.stringify({ step_index: 1, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [
          { id: 'c_bad', name: 'run_command', args: { CommandLine: 'echo same' } },
          { id: 'c_good', name: 'read_file', args: { Path: '/tmp/ok.txt' } }
        ]
      }),
      JSON.stringify({ step_index: 3, type: 'GENERIC', status: 'ERROR', content: 12345 }),
      JSON.stringify({ step_index: 4, type: 'GENERIC', status: 'DONE', content: 'ok file' }),
      JSON.stringify({
        step_index: 5,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Wakeup done.'
      }),
      ''
    ].join('\n'),
    { flag: 'a' }
  )
  nowMs = (await stat(fullPath)).mtimeMs + 5_000
  await tracker.pollOnce()

  const toolUpdates = emitted.flatMap((e) => {
    const p = chunkSchema.safeParse(e.params)
    return p.success && p.data.update?.sessionUpdate === 'tool_call_update'
      ? [{ id: p.data.update.toolCallId, status: p.data.update.status }]
      : []
  })
  expect(toolUpdates).toEqual([
    { id: 'agy_bg_step_2_0', status: 'failed' },
    { id: 'agy_bg_step_2_1', status: 'completed' }
  ])
  expect(
    emitted.some((e) => e.method === '_agy/turn_update' && bgSchema.safeParse(e.params).data?.end)
  ).toBe(true)

  emitted.length = 0
  await tracker.beginPrompt()
  expect(
    tracker.beforeNotification('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Foreground preamble' }
      }
    })
  ).toBe(true)
  expect(
    tracker.beforeNotification('session/update', {
      sessionId: PROVIDER_SESSION,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'fg_same_cmd',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { CommandLine: 'echo same' }
      }
    })
  ).toBe(true)

  await writeFile(
    fullPath,
    [
      JSON.stringify({ step_index: 6, type: 'USER_INPUT', status: 'DONE', content: 'run bg' }),
      JSON.stringify({
        step_index: 7,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Foreground preamble',
        tool_calls: [{ id: 'fg_1', name: 'run_command', args: { CommandLine: 'echo same' } }]
      }),
      JSON.stringify({
        step_index: 8,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Tool is running as a background task with task id: ..\\..\\escaped-task'
      }),
      ''
    ].join('\n'),
    { flag: 'a' }
  )
  await tracker.abortPrompt()

  const abortedBg = emitted.flatMap((e) => {
    const p = bgSchema.safeParse(e.params)
    return e.method === '_agy/turn_update' && p.success ? (p.data.backgroundTasks ?? []) : []
  })
  expect(abortedBg).toEqual([
    expect.objectContaining({
      taskId: '..\\..\\escaped-task',
      state: 'working',
      outputFile: join(sysDir, 'tasks', 'escaped-task.log')
    })
  ])

  emitted.length = 0
  await tracker.beginPrompt()
  const bigStep1 = `STEP1_${'A'.repeat(40_000)}_END1`
  const bigStep2 = `STEP2_${'B'.repeat(40_000)}_END2`
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: bigStep1 } }
  })
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'long_call_1',
      kind: 'read',
      name: 'read_file',
      status: 'completed',
      rawInput: { Path: '/tmp/step1.txt' }
    }
  })
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Next step' } }
  })
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: bigStep2 } }
  })
  await writeFile(
    fullPath,
    [
      JSON.stringify({ step_index: 9, type: 'USER_INPUT', status: 'DONE', content: 'long' }),
      JSON.stringify({
        step_index: 10,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: bigStep1,
        tool_calls: [{ id: 'lc1', name: 'read_file', args: { Path: '/tmp/step1.txt' } }]
      }),
      JSON.stringify({ step_index: 11, type: 'GENERIC', status: 'DONE', content: 'step1 body' }),
      JSON.stringify({
        step_index: 12,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        thinking: 'Next step',
        content: bigStep2
      }),
      ''
    ].join('\n'),
    { flag: 'a' }
  )
  await tracker.finishPrompt({ stopReason: 'end_turn' })
  expect(emitted.filter((e) => e.method === 'session/update')).toEqual([])
  tracker.dispose()
})

it('consumes overlapping head/tail text once, excludes partial aborted foreground steps, reconciles skipped tool gaps, avoids mismatched fallback pairing, and resets shrunk transcripts', async () => {
  const { userHome, fullPath } = await createBrainHome()
  await writeFile(
    fullPath,
    `${JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content: 'start' })}\n`
  )
  const emitted: { method: string; params: unknown }[] = []
  const tracker = createAntigravityPromptTurnTracker(
    { HOME: userHome, USERPROFILE: userHome },
    { activePollMs: 60_000 }
  )
  tracker.attach(PROVIDER_SESSION, (method, params) => emitted.push({ method, params }))
  await tracker.pollOnce()
  emitted.length = 0

  // 1) Overlapping head/tail ('Done.') must be consumed only once so an identical raced wakeup 'Done.' still streams,
  //    AND an open tool `echo other` must NOT pair with an unrelated `echo bg` running step!
  await tracker.beginPrompt()
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } }
  })
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'open_other_cmd',
      kind: 'execute',
      status: 'in_progress',
      rawInput: { CommandLine: 'echo other' }
    }
  })
  await writeFile(
    fullPath,
    [
      JSON.stringify({ step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'do' }),
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Done.',
        tool_calls: [{ id: 'bg1', name: 'run_command', args: { CommandLine: 'echo bg' } }]
      }),
      JSON.stringify({
        step_index: 3,
        type: 'GENERIC',
        status: 'RUNNING',
        content: 'Tool is running as a background task with task id: sess/task-unmatched'
      }),
      JSON.stringify({ step_index: 4, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
      JSON.stringify({ step_index: 5, type: 'PLANNER_RESPONSE', status: 'DONE', content: 'Done.' }),
      ''
    ].join('\n'),
    { flag: 'a' }
  )
  // Wire delivered `echo bg` too so step 2 is complete, while `open_other_cmd` has an unrelated command
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'closed_bg_cmd',
      kind: 'execute',
      status: 'completed',
      rawInput: { CommandLine: 'echo bg' }
    }
  })
  await tracker.finishPrompt({ stopReason: 'end_turn' })
  // `open_other_cmd` was NOT completed with `sess/task-unmatched` output
  expect(
    emitted.some((e) => {
      const p = chunkSchema.safeParse(e.params)
      return p.success && p.data.update?.toolCallId === 'open_other_cmd'
    })
  ).toBe(false)
  // Raced wakeup 'Done.' at step 5 WAS streamed because 'Done.' at step 2 consumed the single wire occurrence!
  expect(
    emitted.flatMap((e) => {
      const p = chunkSchema.safeParse(e.params)
      return p.success && p.data.update?.sessionUpdate === 'agent_message_chunk'
        ? [p.data.update.content?.text]
        : []
    })
  ).toEqual(['Done.'])

  // 2) Aborted foreground prompt with partial wire text ('Part' vs 'Partial answer') is NOT re-emitted as reactive!
  emitted.length = 0
  await tracker.beginPrompt()
  tracker.beforeNotification('session/update', {
    sessionId: PROVIDER_SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Part' } }
  })
  await writeFile(
    fullPath,
    [
      JSON.stringify({ step_index: 6, type: 'USER_INPUT', status: 'DONE', content: 'abort me' }),
      JSON.stringify({
        step_index: 7,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Partial answer'
      }),
      ''
    ].join('\n'),
    { flag: 'a' }
  )
  await tracker.abortPrompt()
  expect(emitted.filter((e) => e.method === 'session/update')).toEqual([])

  // 3) Corrupt gap at step 10 (missing step between step 9 tool A and step 11 tool B) fails tool A before tool B runs,
  //    AND shrinking the transcript resets step state so replacement step 0 streams cleanly!
  emitted.length = 0
  await writeFile(
    fullPath,
    [
      JSON.stringify({ step_index: 8, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
      JSON.stringify({
        step_index: 9,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'gap_a', name: 'read_file', args: { Path: '/tmp/a' } }]
      }),
      '{corrupt json line for step 10',
      JSON.stringify({
        step_index: 11,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ id: 'gap_b', name: 'read_file', args: { Path: '/tmp/b' } }]
      }),
      JSON.stringify({ step_index: 12, type: 'GENERIC', status: 'DONE', content: 'b result' }),
      ''
    ].join('\n'),
    { flag: 'a' }
  )
  await tracker.pollOnce() // records stalledGapIndex = 10
  await tracker.pollOnce() // skips gap 10, fails gap_a, runs & completes gap_b!
  const gapUpdates = emitted.flatMap((e) => {
    const p = chunkSchema.safeParse(e.params)
    return p.success && p.data.update?.sessionUpdate === 'tool_call_update'
      ? [{ id: p.data.update.toolCallId, status: p.data.update.status }]
      : []
  })
  expect(gapUpdates).toEqual([
    { id: 'agy_bg_step_9_0', status: 'failed' },
    { id: 'agy_bg_step_11_0', status: 'completed' }
  ])

  // Shrink transcript back to a tiny replacement with step_index 0..1
  emitted.length = 0
  await writeFile(
    fullPath,
    [
      JSON.stringify({ step_index: 0, type: 'SYSTEM_MESSAGE', status: 'DONE' }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'After shrink!'
      }),
      ''
    ].join('\n')
  )
  await tracker.pollOnce()
  expect(
    emitted.flatMap((e) => {
      const p = chunkSchema.safeParse(e.params)
      return p.success && p.data.update?.sessionUpdate === 'agent_message_chunk'
        ? [p.data.update.content?.text]
        : []
    })
  ).toEqual(['After shrink!'])
  tracker.dispose()
})
