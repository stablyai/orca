import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { AcpScriptedAgent } from '../acp/acp-scripted-agent.test-support'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { openAcpAdapterRig, sendHello } from '../acp/acp-structured-adapter.test-support'
import {
  closeProviderTimelineRigs,
  messageText,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { readOpenCodePromptFailure } from '../foreign-sqlite-readers/readers/opencode-prompt-failure'
import type { OpenCodePromptFailureQuery } from '../foreign-sqlite-readers/opencode-prompt-failure-result'
import SyncDatabase from '../sqlite/sync-database'
import { createOpenCodeAcpConnection } from './opencode-acp-connection'

const NOW = 1_800_000_000_000
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

async function fixture(
  native: unknown,
  options: {
    stale?: boolean
    start?: boolean
    unavailable?: boolean
    readGate?: Promise<void>
    readStarted?: () => void
    acpCode?: number
  } = {}
) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-opencode-acp-failure-'))
  const dataHome = join(directory, 'account-data')
  mkdirSync(join(dataHome, 'opencode'), { recursive: true })
  const dbPath = join(dataHome, 'opencode', 'opencode.db')
  const db = new SyncDatabase(dbPath)
  db.exec(`CREATE TABLE session_message (
    id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT
  )`)
  const agent = new AcpScriptedAgent()
  const child = Object.assign(createFakePipedChild(), {
    pid: 9_999_999,
    stdout: agent.stdout,
    stdin: agent.stdin,
    stderr: new PassThrough()
  })
  agent.on('initialize', (frame) => agent.reply(frame, { protocolVersion: 1 }))
  agent.on('session/new', (frame) => agent.reply(frame, { sessionId: 'ses-own' }))
  let turn = 0
  agent.on('session/prompt', (frame) => {
    turn++
    db.prepare('INSERT OR REPLACE INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
      `input-${turn}`,
      'ses-own',
      'user',
      turn * 10,
      NOW,
      '{}'
    )
    db.prepare('INSERT OR REPLACE INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
      `outcome-${turn}`,
      'ses-own',
      'idle',
      turn * 10 + 1,
      options.stale ? 1 : NOW,
      JSON.stringify({ error: native })
    )
    agent.fail(
      frame,
      options.acpCode ?? -32000,
      'Authentication required: provider authentication required',
      {
        details: 'provider authentication required'
      }
    )
  })
  const readFailure = vi.fn(async (query: OpenCodePromptFailureQuery) => {
    if (options.unavailable) {
      throw new Error('database unavailable')
    }
    const result = readOpenCodePromptFailure(query)
    options.readStarted?.()
    await options.readGate
    return result
  })
  const connection = createOpenCodeAcpConnection(
    {
      command: 'opencode2',
      args: ['acp'],
      cwd: directory,
      env: { XDG_DATA_HOME: dataHome },
      envToDelete: ['OPENCODE_DB']
    },
    {},
    () => child,
    readFailure
  )
  cleanups.push(async () => {
    child.emit('exit', 0, null)
    await connection.close()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  if (options.start !== false) {
    await connection.start({ cwd: directory, mcpServers: [] })
  }
  return { connection, readFailure, dbPath, agent, child, cwd: directory }
}

const quota = { type: 'provider.quota', message: 'Free usage limit reached.', status: 429 }

describe('OpenCode ACP native failure recovery', () => {
  it('journals the recovered failure through the full chat adapter and accepts the next send', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const spec = acpLaunchSpecFor('opencode2')
    if (!spec) {
      throw new Error('OpenCode 2 launch specification missing')
    }
    const { connection, agent, cwd } = await fixture(
      { ...quota, retryAfterMs: 60_000 },
      { start: false }
    )
    const rig = await openAcpAdapterRig({
      spec,
      launch: { cwd },
      deps: { connect: () => connection, now: Date.now }
    })
    cleanups.push(async () => {
      await rig.adapter.closeSession(SESSION)
    })
    await rig.acquire()
    await sendHello(rig, 'first')
    await rig.settle()
    expect((await rig.rig.rows()).map((row) => row.body)).toContainEqual(
      expect.objectContaining({
        kind: 'status',
        tone: 'warning',
        failure: expect.objectContaining({
          kind: 'usageLimitReached',
          detail: { text: quota.message, audience: 'person' },
          usageLimit: { resetsAt: expect.any(Number) }
        })
      })
    )
    expect((await rig.rig.turns())[0]?.outcome).toBe('failure')
    agent.on('session/prompt', (frame) => {
      agent.notify('session/update', {
        sessionId: 'ses-own',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'reply after failure' }
        }
      })
      agent.reply(frame, { stopReason: 'end_turn' })
    })
    await sendHello(rig, 'second')
    await rig.settle()
    expect((await rig.rig.turns()).map((turn) => turn.outcome)).toEqual(['failure', 'success'])
    expect((await rig.rig.rows()).map((row) => messageText(row.body))).toContain(
      'reply after failure'
    )
  })
})
