import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, postHookEvent } from '../../server.test-fixtures'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-agy-swarm-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

function jsonl(...records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function createBrainTranscript(
  brainRoot: string,
  conversationId: string,
  records: unknown[]
): { brainDir: string; transcriptPath: string } {
  const brainDir = join(brainRoot, conversationId)
  const logsDir = join(brainDir, '.system_generated', 'logs')
  mkdirSync(logsDir, { recursive: true })
  const transcriptPath = join(logsDir, 'transcript.jsonl')
  writeFileSync(transcriptPath, jsonl(...records))
  return { brainDir, transcriptPath }
}

async function agyHook(payload: Record<string, unknown>, hookEventName: string): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody(payload, { hookEventName }),
    '/hook/antigravity'
  )
  expect(response.status).toBe(204)
}

async function waitForChildren(ids: string[]): Promise<void> {
  await vi.waitFor(() =>
    expect(server.getStatusSnapshot()[0]?.subagents?.map((child) => child.id) ?? []).toEqual(ids)
  )
}

const ROOT_ORIGIN = {
  step_index: 0,
  source: 'USER_EXPLICIT',
  type: 'USER_INPUT',
  created_at: '2026-11-17T10:00:00.000Z',
  content: 'Audit auth and billing modules'
}

const CHILD_ORIGIN = {
  step_index: 0,
  source: 'SYSTEM',
  type: 'SYSTEM_MESSAGE',
  created_at: '2026-11-17T10:00:01.000Z',
  content: 'sender=root'
}

it('tracks active swarm workers via hooks and 1s metadata polls while preserving parent state', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  const brainRoot = join(dir, 'brain')
  const rootId = '10000000-0000-4000-8000-000000000001'
  const w1 = '20000000-0000-4000-8000-000000000001'
  const w2 = '20000000-0000-4000-8000-000000000002'
  const w3 = '20000000-0000-4000-8000-000000000003'
  const w4 = '20000000-0000-4000-8000-000000000004'

  const rootBrain = createBrainTranscript(brainRoot, rootId, [ROOT_ORIGIN])
  const worker1Brain = createBrainTranscript(brainRoot, w1, [CHILD_ORIGIN])
  const worker2Brain = createBrainTranscript(brainRoot, w2, [CHILD_ORIGIN])
  createBrainTranscript(brainRoot, w3, [CHILD_ORIGIN])
  createBrainTranscript(brainRoot, w4, [CHILD_ORIGIN])

  const swarmDir = join(rootBrain.brainDir, '.system_generated', 'swarm')
  mkdirSync(swarmDir, { recursive: true })
  const membersPath = join(swarmDir, 'members.json')
  const writeMembers = (w1Wake: string, w2Wake: string, w1Model = 'gemini-3.1-pro-high') => {
    writeFileSync(
      membersPath,
      JSON.stringify({
        title: 'Security & billing audit',
        members: {
          coordinator: {
            conversation_id: rootId,
            role: 'coordinator',
            phase: 'RUNNING',
            desired_state: 'RUNNING',
            wake_mode: 'mentions',
            killed: false,
            applied_model: 'gemini-3.1-pro-high'
          },
          auth_audit: {
            conversation_id: w1,
            role: 'worker',
            phase: 'RUNNING',
            desired_state: 'RUNNING',
            wake_mode: w1Wake,
            killed: false,
            applied_model: w1Model
          },
          billing_check: {
            conversation_id: w2,
            role: 'worker',
            phase: 'RUNNING',
            desired_state: 'RUNNING',
            wake_mode: w2Wake,
            killed: false,
            applied_model: 'gemini-3-flash'
          },
          board_monitor: {
            conversation_id: w3,
            role: 'worker',
            phase: 'RUNNING',
            desired_state: 'RUNNING',
            wake_mode: 'mentions',
            killed: false,
            applied_model: 'gemini-3-flash'
          },
          old_worker: {
            conversation_id: w4,
            role: 'worker',
            phase: 'KILLED',
            desired_state: 'KILLED',
            wake_mode: 'working',
            killed: true
          }
        }
      })
    )
  }

  writeMembers('working', 'working')

  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      lastUserInput: 'Audit auth and billing modules',
      modelName: 'gemini-3.1-pro-high'
    },
    'PreInvocation'
  )
  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      toolCall: { name: 'swarm_wait', args: {} }
    },
    'PreToolUse'
  )
  await waitForChildren([w1, w2])
  await agyHook(
    {
      conversationId: w1,
      transcriptPath: worker1Brain.transcriptPath,
      lastUserInput: '',
      modelName: 'gemini-3.1-pro-high',
      toolCall: { name: 'read_file', args: { path: 'src/auth/session.ts' } }
    },
    'PreToolUse'
  )

  const initial = server.getStatusSnapshot()[0]
  expect(initial?.state).toBe('working')
  expect(initial?.prompt).toBe('Audit auth and billing modules')
  expect(initial?.providerSession?.id).toBe(rootId)
  expect(initial?.model).toBe('gemini-3.1-pro-high')
  expect(initial?.subagents?.map((s) => s.description)).toEqual(['auth_audit', 'billing_check'])
  expect(initial?.subagents?.[0]).toMatchObject({
    id: w1,
    description: 'auth_audit',
    agentType: 'Swarm Worker',
    model: 'gemini-3.1-pro-high',
    toolName: 'read_file',
    toolInput: 'src/auth/session.ts',
    state: 'working'
  })
  expect(initial?.subagents?.[1]).toMatchObject({
    id: w2,
    description: 'billing_check',
    agentType: 'Swarm Worker',
    model: 'gemini-3-flash',
    state: 'working'
  })

  writeMembers('working', 'mentions', 'gemini-3-flash')
  await waitForChildren([w1])
  await vi.waitFor(() =>
    expect(server.getStatusSnapshot()[0]?.subagents?.[0]?.model).toBe('gemini-3-flash')
  )

  const polled = server.getStatusSnapshot()[0]
  expect(polled?.subagents?.map((s) => s.description)).toEqual(['auth_audit'])
  expect(polled?.subagents?.[0]?.model).toBe('gemini-3-flash')

  // Delayed child PostToolUse after parking in 'mentions' must not resurrect the sleeping worker.
  await agyHook(
    {
      conversationId: w2,
      transcriptPath: worker2Brain.transcriptPath,
      lastUserInput: '',
      toolCall: { name: 'run_command', args: { CommandLine: 'pnpm test' } }
    },
    'PostToolUse'
  )
  expect(server.getStatusSnapshot()[0]?.subagents?.map((s) => s.description)).toEqual([
    'auth_audit'
  ])

  writeMembers('mentions', 'mentions')
  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      fullyIdle: true
    },
    'Stop'
  )

  const finished = server.getStatusSnapshot()[0]
  expect(finished?.state).toBe('done')
  expect(finished?.subagents).toBeUndefined()
})

it('tracks invoke_subagent lifecycle, child ask_question waits, and settled ALIVE retirement', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  const brainRoot = join(dir, 'brain')
  const rootId = '30000000-0000-4000-8000-000000000001'
  const childId = '40000000-0000-4000-8000-000000000001'

  const rootBrain = createBrainTranscript(brainRoot, rootId, [ROOT_ORIGIN])
  const childBrain = createBrainTranscript(brainRoot, childId, [CHILD_ORIGIN])

  const subagentsDir = join(rootBrain.brainDir, '.system_generated', 'subagents')
  mkdirSync(subagentsDir, { recursive: true })
  writeFileSync(
    join(subagentsDir, `${childId}.json`),
    JSON.stringify({
      conversationId: childId,
      subagentDescriptor: { typeName: 'research', role: 'Codebase Researcher' },
      state: 'SUBAGENT_STATE_ALIVE',
      spawnStepIndex: 2
    })
  )

  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      lastUserInput: 'Investigate login flow',
      modelName: 'gemini-3.1-pro-high'
    },
    'PreInvocation'
  )
  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      toolCall: { name: 'invoke_subagent', args: { Role: 'Codebase Researcher' } }
    },
    'PreToolUse'
  )
  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      fullyIdle: false
    },
    'Stop'
  )

  await waitForChildren([childId])
  const held = server.getStatusSnapshot()[0]
  expect(held?.state).toBe('working')
  expect(held?.mainAgent?.state).toBe('done')
  expect(held?.subagents).toHaveLength(1)
  expect(held?.subagents?.[0]).toMatchObject({
    id: childId,
    description: 'Codebase Researcher',
    agentType: 'research',
    state: 'working'
  })

  await agyHook(
    {
      conversationId: childId,
      transcriptPath: childBrain.transcriptPath,
      lastUserInput: '',
      modelName: 'gemini-3-flash',
      stepIdx: 1,
      toolCall: { name: 'ask_question', args: { question: 'Proceed with migration?' } }
    },
    'PreToolUse'
  )

  const waiting = server.getStatusSnapshot()[0]
  expect(waiting?.state).toBe('waiting')
  expect(waiting?.subagents?.[0]).toMatchObject({
    id: childId,
    model: 'gemini-3-flash',
    toolName: 'ask_question',
    state: 'waiting'
  })

  writeFileSync(
    childBrain.transcriptPath,
    jsonl(CHILD_ORIGIN, {
      step_index: 2,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'gemini-3-flash',
      tool_calls: []
    })
  )
  await agyHook(
    {
      conversationId: childId,
      transcriptPath: childBrain.transcriptPath,
      lastUserInput: '',
      fullyIdle: true
    },
    'Stop'
  )
  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      fullyIdle: true
    },
    'Stop'
  )

  const done = server.getStatusSnapshot()[0]
  expect(done?.state).toBe('done')
  expect(done?.subagents).toBeUndefined()
})

it('preserves done lead on late background PostToolUse and settles when the last helper is killed', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  const brainRoot = join(dir, 'brain')
  const rootId = '50000000-0000-4000-8000-000000000001'
  const childId = '60000000-0000-4000-8000-000000000001'

  const rootBrain = createBrainTranscript(brainRoot, rootId, [ROOT_ORIGIN])
  createBrainTranscript(brainRoot, childId, [CHILD_ORIGIN])

  const subagentsDir = join(rootBrain.brainDir, '.system_generated', 'subagents')
  mkdirSync(subagentsDir, { recursive: true })
  const subagentPath = join(subagentsDir, `${childId}.json`)
  const writeSubagentState = (state: string) => {
    writeFileSync(
      subagentPath,
      JSON.stringify({
        conversationId: childId,
        subagentDescriptor: { typeName: 'self', role: 'Background Worker' },
        state,
        spawnStepIndex: 2
      })
    )
  }
  writeSubagentState('SUBAGENT_STATE_ALIVE')

  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      lastUserInput: 'Run checks and helper',
      modelName: 'gemini-3.1-pro-high'
    },
    'PreInvocation'
  )
  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      stepIdx: 1,
      toolCall: { name: 'run_command', args: { CommandLine: 'pnpm tc', IsDaemon: false } }
    },
    'PreToolUse'
  )
  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      stepIdx: 2,
      toolCall: { name: 'invoke_subagent', args: { Role: 'Background Worker' } }
    },
    'PreToolUse'
  )
  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      fullyIdle: false
    },
    'Stop'
  )

  await waitForChildren([childId])
  expect(server.getStatusSnapshot()[0]?.mainAgent?.state).toBe('done')

  await agyHook(
    {
      conversationId: rootId,
      transcriptPath: rootBrain.transcriptPath,
      stepIdx: 1,
      toolCall: { name: 'run_command', args: { CommandLine: 'pnpm tc', IsDaemon: false } }
    },
    'PostToolUse'
  )

  const afterCommandEnd = server.getStatusSnapshot()[0]
  expect(afterCommandEnd?.state).toBe('working')
  expect(afterCommandEnd?.mainAgent?.state).toBe('done')

  writeSubagentState('SUBAGENT_STATE_KILLED')
  await vi.waitFor(() => expect(server.getStatusSnapshot()[0]?.state).toBe('done'))

  const afterKill = server.getStatusSnapshot()[0]
  expect(afterKill?.state).toBe('done')
  expect(afterKill?.subagents).toBeUndefined()
})

it('keeps discovery alive when an older child and a background command finish before a new child appears', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  const brainRoot = join(dir, 'brain')
  const root = createBrainTranscript(brainRoot, 'parent', [ROOT_ORIGIN])
  createBrainTranscript(brainRoot, 'old-child', [CHILD_ORIGIN])
  const descriptors = join(root.brainDir, '.system_generated', 'subagents')
  mkdirSync(descriptors, { recursive: true })
  const descriptor = (id: string, state: string) =>
    writeFileSync(join(descriptors, `${id}.json`), JSON.stringify({ conversationId: id, state }))
  descriptor('old-child', 'SUBAGENT_STATE_ALIVE')
  const parent = { conversationId: 'parent', transcriptPath: root.transcriptPath }
  await agyHook({ ...parent, lastUserInput: 'Run both tasks' }, 'PreInvocation')
  await agyHook({ ...parent, toolCall: { name: 'swarm_wait', args: {} } }, 'PreToolUse')
  await waitForChildren(['old-child'])
  const command = {
    stepIdx: 1,
    toolCall: { name: 'run_command', args: { CommandLine: 'sleep 1' } }
  }
  await agyHook({ ...parent, ...command }, 'PreToolUse')
  await agyHook(
    { ...parent, stepIdx: 2, toolCall: { name: 'invoke_subagent', args: { Role: 'second' } } },
    'PreToolUse'
  )
  await agyHook({ ...parent, fullyIdle: false }, 'Stop')
  descriptor('old-child', 'SUBAGENT_STATE_KILLED')
  await agyHook({ ...parent, ...command }, 'PostToolUse')
  expect(server.getStatusSnapshot()[0]?.state).toBe('working')
  createBrainTranscript(brainRoot, 'new-child', [CHILD_ORIGIN])
  descriptor('new-child', 'SUBAGENT_STATE_ALIVE')
  await waitForChildren(['new-child'])
})
