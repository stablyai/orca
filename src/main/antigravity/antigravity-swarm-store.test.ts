import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSessionRecordFixture } from '../native-chat/testing/agent-session-record-test-fixture'
import {
  readAntigravitySwarmMemberTranscript,
  readAntigravitySwarmSnapshot
} from './antigravity-swarm-store'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'orca-agy-swarm-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function antigravityRecord(args: {
  accountHomePath: string
  providerSessionId?: string
  provider?: string
}) {
  return agentSessionRecordFixture({
    sessionId: 'session-1234',
    provider: args.provider ?? 'antigravity',
    accountHome: { variable: 'GEMINI_HOME', path: args.accountHomePath },
    providerHandleChain: args.providerSessionId
      ? [
          {
            linkId: 'link-1',
            handle: { transport: 'acp', agent: 'antigravity', nativeId: args.providerSessionId },
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 1
          }
        ]
      : []
  })
}

async function writeSwarmFiles(args: {
  brainDir: string
  swarmId: string
  workerId: string
  boardText?: string
}) {
  const swarmDir = join(args.brainDir, args.swarmId, '.system_generated', 'swarm')
  const workerLogsDir = join(args.brainDir, args.workerId, '.system_generated', 'logs')
  await mkdir(swarmDir, { recursive: true })
  await mkdir(workerLogsDir, { recursive: true })
  await writeFile(
    join(swarmDir, 'members.json'),
    JSON.stringify({
      title: 'Auth Refactor',
      members: {
        coordinator: {
          conversation_id: args.swarmId,
          model: 'gemini-3.1-pro',
          role: 'coordinator',
          wake_mode: 'mentions',
          last_read_seq: 1
        },
        'backend-dev': {
          conversation_id: args.workerId,
          model: 'claude-sonnet-4-6',
          role: 'worker',
          wake_mode: 'mentions',
          worktree: '/tmp/wt-backend',
          last_read_seq: 0
        }
      }
    })
  )
  await writeFile(
    join(swarmDir, 'board.jsonl'),
    args.boardText ??
      `${JSON.stringify({
        seq: 1,
        agent: 'coordinator',
        text: '@backend-dev please inspect auth.ts',
        time: '2026-11-16 15:00:00'
      })}\n`
  )
  await writeFile(
    join(swarmDir, 'plan.json'),
    JSON.stringify({
      goal: { title: 'Auth Refactor' },
      steps: [{ title: 'Inspect auth', status: 'in_progress', owner: 'backend-dev' }]
    })
  )
  await writeFile(
    join(workerLogsDir, 'transcript.jsonl'),
    [
      JSON.stringify({
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        content: '<USER_REQUEST>\nInspect auth.ts\n</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        thinking: '**Reading auth module**\nchecking token checks',
        tool_calls: [{ name: 'view_file', args: { AbsolutePath: 'src/auth.ts' } }]
      })
    ].join('\n')
  )
}

describe('antigravity-swarm-store', () => {
  it('reads host agy swarm snapshot and supports etag short-circuiting', async () => {
    const root = await createTempDir()
    const geminiHome = join(root, '.gemini')
    const brainDir = join(geminiHome, 'antigravity-cli', 'brain')
    await writeSwarmFiles({
      brainDir,
      swarmId: 'conv-coord-1',
      workerId: 'conv-worker-1'
    })

    const record = antigravityRecord({
      accountHomePath: geminiHome,
      providerSessionId: 'conv-coord-1'
    })

    const first = await readAntigravitySwarmSnapshot(record, { now: 1_000_000 })
    expect(first.status).toBe('ok')
    if (first.status !== 'ok') {
      throw new Error('Expected ok snapshot')
    }
    expect(first.snapshot.title).toBe('Auth Refactor')
    expect(first.snapshot.plan?.steps).toHaveLength(1)
    expect(first.snapshot.members.find((m) => m.name === 'backend-dev')).toMatchObject({
      worktree: '/tmp/wt-backend',
      unread: 1,
      status: 'working',
      activity: 'Read auth.ts',
      activityKind: 'tool'
    })

    const cached = await readAntigravitySwarmSnapshot(record, {
      ifNoneMatch: first.snapshot.etag,
      now: 1_000_001
    })
    expect(cached).toEqual({ status: 'unchanged', etag: first.snapshot.etag })

    await writeSwarmFiles({
      brainDir,
      swarmId: 'conv-coord-1',
      workerId: 'conv-worker-1',
      boardText:
        `${JSON.stringify({ seq: 1, agent: 'coordinator', text: '@backend-dev go', time: '2026-11-16 15:00:00' })}\n` +
        `${JSON.stringify({ seq: 2, agent: 'backend-dev', text: 'Done', time: '2026-11-16 15:01:00' })}\n`
    })

    const updated = await readAntigravitySwarmSnapshot(record, {
      ifNoneMatch: first.snapshot.etag,
      now: 1_000_002
    })
    expect(updated.status).toBe('ok')
    if (updated.status === 'ok') {
      expect(updated.snapshot.headSeq).toBe(2)
      expect(updated.snapshot.messages).toHaveLength(2)
    }
  })

  it('resolves managed antigravity-chat brain dir and checks provider/missing states', async () => {
    const root = await createTempDir()
    const managedHome = join(root, 'antigravity-chat')
    const brainDir = join(managedHome, 'antigravity-acp', 'brain')
    await writeSwarmFiles({
      brainDir,
      swarmId: 'conv-coord-2',
      workerId: 'conv-worker-2'
    })

    const managedRecord = antigravityRecord({
      accountHomePath: managedHome,
      providerSessionId: 'conv-coord-2'
    })
    const res = await readAntigravitySwarmSnapshot(managedRecord)
    expect(res.status).toBe('ok')

    const nonAgy = antigravityRecord({
      accountHomePath: managedHome,
      providerSessionId: 'conv-coord-2',
      provider: 'claude'
    })
    expect(await readAntigravitySwarmSnapshot(nonAgy)).toEqual({ status: 'unsupported' })

    const missingSwarm = antigravityRecord({
      accountHomePath: managedHome,
      providerSessionId: 'conv-does-not-exist'
    })
    expect(await readAntigravitySwarmSnapshot(missingSwarm)).toEqual({ status: 'none' })
  })

  it('reads member transcripts only for valid members of the session swarm', async () => {
    const root = await createTempDir()
    const geminiHome = join(root, '.gemini')
    const brainDir = join(geminiHome, 'antigravity-cli', 'brain')
    await writeSwarmFiles({
      brainDir,
      swarmId: 'conv-coord-3',
      workerId: 'conv-worker-3'
    })

    const record = antigravityRecord({
      accountHomePath: geminiHome,
      providerSessionId: 'conv-coord-3'
    })

    const transcript = await readAntigravitySwarmMemberTranscript(record, {
      conversationId: 'conv-worker-3'
    })
    expect(transcript.status).toBe('ok')
    if (transcript.status === 'ok') {
      expect(transcript.entries).toHaveLength(2)
      expect(transcript.entries[0]?.text).toBe('Inspect auth.ts')
    }

    expect(
      await readAntigravitySwarmMemberTranscript(record, { conversationId: '../etc/passwd' })
    ).toEqual({ status: 'none' })

    expect(
      await readAntigravitySwarmMemberTranscript(record, { conversationId: 'conv-unrelated' })
    ).toEqual({ status: 'none' })
  })

  it('invalidates etag once a terminal tool error settles and propagates non-missing read errors', async () => {
    const root = await createTempDir()
    const geminiHome = join(root, '.gemini')
    const brainDir = join(geminiHome, 'antigravity-cli', 'brain')
    await writeSwarmFiles({
      brainDir,
      swarmId: 'conv-coord-4',
      workerId: 'conv-worker-4'
    })
    const workerTranscriptPath = join(
      brainDir,
      'conv-worker-4',
      '.system_generated',
      'logs',
      'transcript.jsonl'
    )
    await writeFile(
      workerTranscriptPath,
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'ERROR',
        error: '429 RESOURCE_EXHAUSTED'
      })
    )
    const { mtimeMs } = await stat(workerTranscriptPath)
    const record = antigravityRecord({
      accountHomePath: geminiHome,
      providerSessionId: 'conv-coord-4'
    })

    const unsettled = await readAntigravitySwarmSnapshot(record, { now: mtimeMs + 2_000 })
    expect(unsettled.status).toBe('ok')
    if (unsettled.status !== 'ok') {
      throw new Error('Expected ok snapshot')
    }
    expect(unsettled.snapshot.members.find((m) => m.name === 'backend-dev')?.failure).toBeNull()

    const settled = await readAntigravitySwarmSnapshot(record, {
      ifNoneMatch: unsettled.snapshot.etag,
      now: mtimeMs + 11_000
    })
    expect(settled.status).toBe('ok')
    if (settled.status === 'ok') {
      expect(settled.snapshot.members.find((m) => m.name === 'backend-dev')?.failure).toEqual({
        kind: 'quota',
        text: '429 RESOURCE_EXHAUSTED'
      })
    }

    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const boardPath = join(brainDir, 'conv-coord-4', '.system_generated', 'swarm', 'board.jsonl')
      await chmod(boardPath, 0o000)
      try {
        await expect(readAntigravitySwarmSnapshot(record)).rejects.toThrow()
      } finally {
        await chmod(boardPath, 0o644)
      }
    }
  })
})
