// Captured Claude permission hooks (claude-permission-approve-deny-hooks.jsonl) on an SSH pane: a
// real relay-side listener forwards to a real desktop server, and the desktop can drop off while
// the remote Claude keeps running. The relay caches one row per pane, so a hook that lands during
// the gap overwrites the PostToolUse that ended the request the desktop is still showing.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import { hookAt, loadCapture } from './claude-cancel-capture.test-fixture'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const records = loadCapture('claude-permission-approve-deny-hooks')
const prompt = hookAt(records, 0).payload
const firstTool = hookAt(records, 1).payload
const firstPermission = hookAt(records, 2).payload
const firstNotification = hookAt(records, 3).payload
const firstToolDone = hookAt(records, 4).payload
const secondTool = hookAt(records, 5).payload

const temporaryPaths: string[] = []
const running: { stop: () => void }[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

type SshPane = {
  relay: RelayAgentHookServer
  desktop: AgentHookServer
  connected: boolean
  forwarded: AgentHookRelayEnvelope[]
  post: (payload: Record<string, unknown>) => Promise<void>
}

async function startSshPane(): Promise<SshPane> {
  const endpointDir = mkdtempSync(join(tmpdir(), 'orca-relayed-permission-'))
  temporaryPaths.push(endpointDir)
  const pane: SshPane = {
    desktop: new AgentHookServer(),
    connected: true,
    forwarded: [],
    relay: new RelayAgentHookServer({
      endpointDir,
      token: 'relayed-permission-token',
      forward: (envelope) => {
        pane.forwarded.push(envelope)
        if (pane.connected) {
          pane.desktop.ingestRemote(envelope, 'conn-1')
        }
      }
    }),
    post: async (payload) => {
      const { port, token } = pane.relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    }
  }
  running.push(pane.relay, pane.desktop)
  await pane.relay.start({ publishEndpoint: false })
  return pane
}

async function postAll(pane: SshPane, payloads: Record<string, unknown>[]): Promise<void> {
  for (const payload of payloads) {
    await pane.post(payload)
  }
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

async function waitingOnFirstRequest(): Promise<SshPane> {
  const pane = await startSshPane()
  await postAll(pane, [prompt, firstTool, firstPermission, firstNotification])
  expect(row(pane.desktop)).toMatchObject({ state: 'waiting', toolName: 'Bash' })
  return pane
}

function reconnect(pane: SshPane): void {
  pane.connected = true
  pane.relay.replayCachedPayloadsForPanes()
}

describe('a relayed Claude permission wait across a reconnect (captured)', () => {
  it('clears live when the approved request ends while connected', async () => {
    const pane = await waitingOnFirstRequest()
    await postAll(pane, [firstToolDone, secondTool])
    expect(row(pane.desktop)).toMatchObject({ state: 'working' })
  })

  it('clears on reconnect when the request ended while the desktop was away', async () => {
    const pane = await waitingOnFirstRequest()
    pane.connected = false
    // The user approved on the remote terminal; Claude ran it and started its next tool.
    await postAll(pane, [firstToolDone, secondTool])
    reconnect(pane)

    expect(row(pane.desktop)).toMatchObject({ state: 'working', toolName: 'Bash' })
    expect(row(pane.desktop).toolInput).toContain('second-file.txt')
    const replay = pane.forwarded.at(-1)
    expect(replay).toMatchObject({
      isReplay: true,
      hookEventName: 'PreToolUse',
      claudeSettledRequests: [{ toolUseId: firstToolDone.tool_use_id }]
    })
  })

  it('keeps the wait when the request the desktop shows has not ended', async () => {
    const pane = await waitingOnFirstRequest()
    pane.connected = false
    // A different tool's activity is not evidence that the pending request was answered.
    await postAll(pane, [
      { ...firstToolDone, tool_use_id: 'toolu_other' },
      { ...secondTool, tool_use_id: 'toolu_next' }
    ])
    reconnect(pane)

    expect(row(pane.desktop)).toMatchObject({ state: 'waiting' })
    expect(row(pane.desktop).toolInput).toContain('first-file.txt')
  })

  it('does not carry an ended request into a new Claude session', async () => {
    const pane = await waitingOnFirstRequest()
    pane.connected = false
    await pane.post(firstToolDone)
    await pane.post({ ...secondTool, session_id: '11111111-1111-4111-8111-111111111111' })
    reconnect(pane)

    expect(pane.forwarded.at(-1)?.claudeSettledRequests).toBeUndefined()
  })

  it('ignores settled requests on a live (non-replay) envelope', async () => {
    const pane = await waitingOnFirstRequest()
    pane.connected = false
    await pane.post(secondTool)
    const live = pane.forwarded.at(-1)
    expect(live).toMatchObject({ hookEventName: 'PreToolUse' })
    expect(live?.isReplay).toBeUndefined()
    pane.connected = true
    pane.desktop.ingestRemote(
      {
        ...live,
        paneKey: PANE,
        payload: live?.payload,
        claudeSettledRequests: [{ toolUseId: String(firstTool.tool_use_id) }]
      },
      'conn-1'
    )
    expect(row(pane.desktop)).toMatchObject({ state: 'waiting' })
  })
})
