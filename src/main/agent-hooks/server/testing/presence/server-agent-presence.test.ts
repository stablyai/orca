import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'unverifiable')
)
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe
}))
const servers: AgentHookServer[] = []
const temporaryPaths: string[] = []

function createUserDataPath(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  probe.mockReset()
  probe.mockResolvedValue('unverifiable')
})

async function hook(
  server: AgentHookServer,
  event: string,
  session = 'session-a',
  reason?: string,
  pid: number | null = 4001
): Promise<void> {
  const agentProcess =
    pid === null
      ? undefined
      : JSON.stringify({ pid, platform: process.platform, startTime: `birth-${pid}` })
  const response = await postHookEvent(
    server,
    buildBody(
      {
        hook_event_name: event,
        session_id: session,
        source: 'startup',
        reason,
        ...(event === 'UserPromptSubmit' ? { prompt: `${session} task` } : {})
      },
      { agentProcess }
    )
  )
  expect(response.status).toBe(204)
}

describe('retained agent exit', () => {
  it('keeps a persisted exit through a spooled start written before it', async () => {
    const now = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const userDataPath = createUserDataPath('orca-presence-exit-spool-')
    const first = new AgentHookServer()
    servers.push(first)
    await first.start({ env: 'production', userDataPath })
    const attachedAt = now - 1
    // Spool timestamps have whole-second precision.
    const spooledAt = now - 5_000
    await hook(first, 'SessionStart')
    await hook(first, 'SessionEnd', 'session-a', 'prompt_input_exit')
    first.flushStatusPersistSync()
    first.stop()
    const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
    mkdirSync(spoolDir, { recursive: true })
    writeFileSync(
      join(spoolDir, 'pane-spooled.jsonl'),
      `\n${JSON.stringify({
        paneKey: PANE,
        source: 'claude',
        receivedAt: spooledAt,
        agentProcess: JSON.stringify({
          pid: 4009,
          platform: process.platform,
          startTime: 'birth-4009'
        }),
        payload: { hook_event_name: 'SessionStart', session_id: 'session-old', source: 'startup' }
      })}\n`
    )
    const restarted = new AgentHookServer()
    servers.push(restarted)
    await restarted.start({ env: 'production', userDataPath })
    expect(await restarted.checkAgentPresenceSince(PANE, attachedAt)).toBe('exited')
  })
})
