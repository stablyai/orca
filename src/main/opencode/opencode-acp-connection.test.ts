import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakePipedChild } from '../../shared/__fixtures__/fake-spawned-child'
import { AcpScriptedAgent, deferred } from '../acp/acp-scripted-agent.test-support'
import { AcpAgentError, AcpAuthRequiredError } from '../acp/acp-errors'
import { AcpTimelineTranslator } from '../acp/acp-timeline-translator'
import { acpLaunchSpecFor } from '../acp/acp-launch-specs'
import { openAcpAdapterRig, sendHello } from '../acp/acp-structured-adapter.test-support'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { OPENCODE_ACP_DIALECT } from '../acp/acp-dialects/opencode-dialect'
import { readOpenCodePromptFailure } from '../foreign-sqlite-readers/readers/opencode-prompt-failure'
import type { OpenCodePromptFailureQuery } from '../foreign-sqlite-readers/opencode-prompt-failure-result'
import SyncDatabase from '../sqlite/sync-database'
import { createOpenCodeAcpConnection } from './opencode-acp-connection'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.unstubAllEnvs()
  await closeProviderTimelineRigs()
})

async function fixture(
  native: unknown,
  options: {
    stale?: boolean
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
      Date.now(),
      '{}'
    )
    db.prepare('INSERT OR REPLACE INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(
      `outcome-${turn}`,
      'ses-own',
      'idle',
      turn * 10 + 1,
      options.stale ? 1 : Date.now(),
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
  await connection.start({ cwd: directory, mcpServers: [] })
  return { connection, readFailure, dbPath, agent, child, cwd: directory }
}

const quota = { type: 'provider.quota', message: 'Free usage limit reached.', status: 429 }

describe('OpenCode ACP native failure recovery', () => {
  it('leaves successful turns off the native failure reader', async () => {
    const { connection, readFailure, agent } = await fixture(quota)
    agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    await expect(connection.prompt([{ type: 'text', text: 'hello' }])).resolves.toEqual({
      stopReason: 'end_turn'
    })
    expect(readFailure).not.toHaveBeenCalled()
  })

  it('reads the selected account after stripping an inherited database override', async () => {
    vi.stubEnv('OPENCODE_DB', join(tmpdir(), 'other-account', 'opencode.db'))
    const { connection, readFailure, dbPath } = await fixture(quota)
    await expect(connection.prompt([{ type: 'text', text: 'hello' }])).rejects.toMatchObject({
      message: quota.message
    })
    expect(readFailure).toHaveBeenCalledWith(expect.objectContaining({ dbPath }))
  })

  it.each([-32000, -32603])(
    'reports native quota correctly when ACP returns %i',
    async (acpCode) => {
      const { connection, readFailure, dbPath } = await fixture(quota, { acpCode })
      const error: unknown = await connection
        .prompt([{ type: 'text', text: 'hello' }])
        .catch((e) => e)
      expect(error).toBeInstanceOf(AcpAgentError)
      expect(error).not.toBeInstanceOf(AcpAuthRequiredError)
      if (!(error instanceof AcpAgentError)) {
        throw error
      }
      expect(error.message).toBe(quota.message)
      expect(error.data).toMatchObject({ errorName: 'provider.quota', status: 429 })
      expect(readFailure).toHaveBeenCalledWith(
        expect.objectContaining({ dbPath, sessionId: 'ses-own' })
      )
      const translator = new AcpTimelineTranslator({
        sessionId: 'ses-own',
        agentName: 'OpenCode 2',
        dialect: OPENCODE_ACP_DIALECT
      })
      translator.openPrompt('send', 100)
      const rows = translator.promptFailed('send', error, 200)
      expect(rows).toContainEqual(
        expect.objectContaining({
          type: 'item.update',
          body: expect.objectContaining({
            failure: expect.objectContaining({
              kind: 'usageLimitReached',
              detail: { text: quota.message, audience: 'person' }
            })
          })
        })
      )
    }
  )

  it('journals the recovered failure through the full chat adapter and accepts the next send', async () => {
    const spec = acpLaunchSpecFor('opencode2')
    if (!spec) {
      throw new Error('OpenCode 2 launch specification missing')
    }
    const { connection, agent, cwd } = await fixture({ ...quota, retryAfterMs: 60_000 })
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
    agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    await sendHello(rig, 'second')
    await rig.settle()
    expect((await rig.rig.turns()).map((turn) => turn.outcome)).toEqual(['failure', 'success'])
  })

  it.each([
    { type: 'provider.quota', message: 'Insufficient account funds', status: 402 },
    {
      type: 'provider.auth',
      message: 'Provider authentication required',
      status: 403,
      response: {
        body: JSON.stringify({ error: { type: 'FreeTierError', message: 'Free tier restricted' } })
      }
    }
  ])('does not turn billing or access refusal into a sign-in failure: $status', async (native) => {
    const { connection } = await fixture(native)
    const error: unknown = await connection
      .prompt([{ type: 'text', text: 'hello' }])
      .catch((e) => e)
    expect(error).not.toBeInstanceOf(AcpAuthRequiredError)
    if (!(error instanceof AcpAgentError)) {
      throw error
    }
    expect(OPENCODE_ACP_DIALECT.promptFailure?.(error, 100)).toBeUndefined()
  })

  it('keeps the same session usable after a quota failure', async () => {
    const { connection, agent } = await fixture(quota)
    await expect(connection.prompt([{ type: 'text', text: 'hello' }])).rejects.toMatchObject({
      message: quota.message
    })
    agent.on('session/prompt', (frame) => agent.reply(frame, { stopReason: 'end_turn' }))
    await expect(connection.prompt([{ type: 'text', text: 'try another model' }])).resolves.toEqual(
      {
        stopReason: 'end_turn'
      }
    )
    expect(connection.closed).toBe(false)
  })

  it('keeps another prompt out until native failure recovery settles', async () => {
    const started = deferred<void>()
    const gate = deferred<void>()
    const { connection, agent } = await fixture(quota, {
      readGate: gate.promise,
      readStarted: () => started.resolve()
    })
    const pending = connection.prompt([{ type: 'text', text: 'first' }]).catch((error) => error)
    await started.promise
    const overlapping = connection
      .prompt([{ type: 'text', text: 'second' }])
      .catch((error) => error)
    gate.resolve()
    await expect(overlapping).resolves.toMatchObject({ message: 'ACP prompt already in progress' })
    await expect(pending).resolves.toMatchObject({ message: quota.message })
    expect(agent.frames.filter((frame) => frame.method === 'session/prompt')).toHaveLength(1)
  })

  it('preserves newer native failure classifications instead of interpreting their raw body again', async () => {
    const { connection } = await fixture({
      type: 'provider.free-limit',
      message: 'Connect a provider or switch models.',
      status: 429,
      response: {
        body: JSON.stringify({ error: { type: 'FreeUsageLimitError', message: 'Legacy message' } })
      }
    })
    await expect(connection.prompt([{ type: 'text', text: 'hello' }])).rejects.toMatchObject({
      message: 'Connect a provider or switch models.',
      data: { errorName: 'provider.free-limit', status: 429 }
    })
  })

  it('does not consume the same native failure twice when successive prompts share a clock tick', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
    try {
      const { connection, agent } = await fixture(quota)
      await expect(connection.prompt([{ type: 'text', text: 'first' }])).rejects.toMatchObject({
        message: quota.message
      })
      agent.on('session/prompt', (frame) => agent.fail(frame, -32000, 'Authentication required'))
      await expect(connection.prompt([{ type: 'text', text: 'second' }])).rejects.toMatchObject({
        name: 'AcpAuthRequiredError',
        message: 'Authentication required'
      })
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps HTTP 401 classified as authentication even with an access error in the body', async () => {
    const { connection } = await fixture({
      type: 'provider.auth',
      message: 'Invalid API key',
      status: 401,
      response: {
        body: JSON.stringify({ error: { type: 'RegionError', message: 'Region blocked' } })
      }
    })
    await expect(connection.prompt([{ type: 'text', text: 'hello' }])).rejects.toMatchObject({
      name: 'AcpAuthRequiredError',
      message: 'Invalid API key'
    })
  })

  it('does not revise a closed connection with a late native read', async () => {
    const started = deferred<void>()
    const gate = deferred<void>()
    const { connection, child } = await fixture(quota, {
      readGate: gate.promise,
      readStarted: () => started.resolve()
    })
    const pending = connection.prompt([{ type: 'text', text: 'hello' }])
    await started.promise
    child.emit('exit', 0, null)
    gate.resolve()
    await expect(pending).rejects.toMatchObject({
      name: 'AcpAuthRequiredError',
      message: 'Authentication required: provider authentication required'
    })
  })

  it('keeps genuine authentication failures classified as signed out', async () => {
    const { connection } = await fixture({
      type: 'provider.auth',
      message: 'Invalid API key',
      status: 401
    })
    await expect(connection.prompt([{ type: 'text', text: 'hello' }])).rejects.toMatchObject({
      name: 'AcpAuthRequiredError',
      message: 'Invalid API key'
    })
  })

  it.each([{ stale: true }, { unavailable: true }])(
    'retains the ACP error without fresh native evidence: %j',
    async (options) => {
      const { connection } = await fixture(quota, options)
      await expect(connection.prompt([{ type: 'text', text: 'hello' }])).rejects.toMatchObject({
        name: 'AcpAuthRequiredError',
        message: 'Authentication required: provider authentication required'
      })
    }
  )
})
