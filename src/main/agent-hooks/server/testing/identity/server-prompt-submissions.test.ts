import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { probeAgentProcessPresence } from '../../../../../shared/agent-status/process/agent-process-presence-probe'
import type { AgentProcessIdentity } from '../../../../../shared/agent-status/process/agent-process-presence'
import { AgentHookServer } from '../../agent-hook-server'
import { readSavedStatus } from '../persistence/last-status.test-fixtures'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe
}))
const root: AgentProcessIdentity = { pid: 4001, platform: 'linux', startTime: 'birth-4001' }
const servers: AgentHookServer[] = []
const dirs: string[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

it('publishes finite admitted original prompt occurrences without persisting or replaying them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-prompt-observation-'))
  dirs.push(dir)
  const server = new AgentHookServer()
  servers.push(server)
  server.setHookRootEvidenceReader(async ({ process }) =>
    process.pid === root.pid ? { verdict: 'root', binding: 'pane-root' } : { verdict: 'nested' }
  )
  await server.start({ env: 'production', userDataPath: dir })
  const post = (name: string, prompt?: string, process: AgentProcessIdentity | null = root) =>
    postHookEvent(
      server,
      buildBody(
        { hook_event_name: name, session_id: 'root', ...(prompt === undefined ? {} : { prompt }) },
        process ? { agentProcess: JSON.stringify(process) } : {}
      )
    )
  const prompt = `exact\n${'x'.repeat(240)}\n trailing `
  await post('UserPromptSubmit', prompt)
  const initial = server.getStatusSnapshotForPane(PANE)[0]?.promptSubmissions
  expect(initial?.map((entry) => entry.textDigest)).toEqual([
    '88e79286d1d5639c273f7eca52e5063704100f1113a3d3f7ba6107264e6fd930'
  ])
  await post('PreToolUse')
  expect(server.getStatusSnapshotForPane(PANE)[0]?.promptSubmissions).toBe(initial)
  await post('UserPromptSubmit', 'child', { ...root, pid: 4002, startTime: 'child' })
  expect(server.getStatusSnapshotForPane(PANE)[0]?.promptSubmissions).toBe(initial)
  await post('UserPromptSubmit', 'unproved', null)
  expect(server.getStatusSnapshotForPane(PANE)[0]?.promptSubmissions).toBe(initial)
  for (let index = 0; index < 9; index++) {
    await post('UserPromptSubmit', `input-${index}`)
  }
  const history = server.getStatusSnapshotForPane(PANE)[0]?.promptSubmissions
  expect(history).toHaveLength(8)
  expect(history?.[0].textDigest).toBe(
    'f7218970d1a5858b1d37bd7f2935222ceb12c787fc91ee5e9ebf03584d5b2a02'
  )
  expect(history?.at(-1)?.textDigest).toBe(
    '172d9be5ad66645e2ecd82e41cd4bd4c3b32d9a6a82110be843b2321cee87a99'
  )
  server.stop()
  const saved = readSavedStatus(join(dir, 'agent-hooks', 'last-status.json'))
  expect(saved).not.toContain('promptSubmissions')
  expect(saved).not.toContain('promptSubmissionDigest')
  await server.start({ env: 'production', userDataPath: dir })
  expect(server.getStatusSnapshotForPane(PANE)[0]?.promptSubmissions).toBeUndefined()
})
