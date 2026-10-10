import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, GOOD_PANE, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn(async () => 'live')
}))

const OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FORK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let root: string
let projectDir: string
const servers: AgentHookServer[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-claude-continuation-'))
  projectDir = join(root, 'claude', 'projects', '-work-repo')
  mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  rmSync(root, { recursive: true, force: true })
})

function transcript(sessionId: string, extra = ''): string {
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'user', sessionId, uuid: 'u1', cwd: '/work/repo' })}\n${extra}`
  )
  return transcriptPath
}

function forkOldIntoJob(): { oldPath: string; forkPath: string } {
  const pointer = { type: 'continued-in', sessionId: OLD, continuedInSessionId: FORK }
  return {
    oldPath: transcript(OLD, `${JSON.stringify(pointer)}\n`),
    forkPath: transcript(FORK)
  }
}

async function createServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: join(root, 'orca') })
  return server
}

async function prompt(server: AgentHookServer, paneKey: string, sessionId: string, path: string) {
  const [tabId] = paneKey.split(':')
  const response = await postHookEvent(
    server,
    buildBody(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        transcript_path: path,
        prompt: 'keep going'
      },
      {
        paneKey,
        tabId,
        agentProcess: JSON.stringify({ pid: 4001, platform: process.platform, startTime: tabId })
      }
    )
  )
  expect(response.status).toBe(204)
}

function row(server: AgentHookServer, paneKey = PANE) {
  return server.getStatusSnapshot().find((entry) => entry.paneKey === paneKey)
}

describe('Claude session continued into a daemon job', () => {
  it("rebinds the pane to the fork named by its own transcript, keeping the row's state", async () => {
    const server = await createServer()
    const { oldPath, forkPath } = forkOldIntoJob()
    await prompt(server, PANE, OLD, oldPath)
    const before = row(server)
    expect(before?.providerSession).toMatchObject({ id: OLD, transcriptPath: oldPath })

    await server.checkAgentPresence(PANE)

    const after = row(server)
    expect(after?.providerSession).toEqual({
      key: 'session_id',
      id: FORK,
      transcriptPath: forkPath
    })
    expect(after?.state).toBe(before?.state)
    expect(after?.prompt).toBe(before?.prompt)
    server.flushStatusPersistSync()
    const persisted = JSON.parse(
      readFileSync(join(root, 'orca', 'agent-hooks', 'last-status.json'), 'utf8')
    )
    expect(persisted.entries[PANE].providerSession.id).toBe(FORK)
  })

  it('leaves the pane alone while its transcript has no continuation', async () => {
    const server = await createServer()
    const oldPath = transcript(OLD)
    transcript(FORK)
    await prompt(server, PANE, OLD, oldPath)

    await server.checkAgentPresence(PANE)

    expect(row(server)?.providerSession?.id).toBe(OLD)
  })

  it('does not claim a fork that another pane already reports', async () => {
    const server = await createServer()
    const { oldPath, forkPath } = forkOldIntoJob()
    await prompt(server, PANE, OLD, oldPath)
    await prompt(server, GOOD_PANE, FORK, forkPath)
    expect(row(server, GOOD_PANE)?.providerSession?.id).toBe(FORK)

    await server.checkAgentPresence(PANE)

    expect(row(server)?.providerSession?.id).toBe(OLD)
    expect(row(server, GOOD_PANE)?.providerSession?.id).toBe(FORK)
  })
})
