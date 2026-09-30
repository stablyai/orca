// The captured background-shell stories on a relayed pane (WSL's local relay: the desktop never
// infers a Ctrl+C on an SSH pane, whose input is not delivery-confirmed): hooks go through a real
// relay-side listener, which owns the task record and reads the transcript, and reach the desktop
// only as relayed rows. The relay never learns the Ctrl+C the desktop infers, so every row it
// publishes afterwards still names its own working main agent.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import {
  cancelLabelled,
  hookAt,
  loadCapture,
  type CapturedTranscriptScan
} from './claude-cancel-capture.test-fixture'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const temporaryPaths: string[] = []
const running: { stop: () => void }[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  // Why: rows and the cancel latch read Date.now(); watch ticks stay on real timers.
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function temporaryDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

type SshPane = {
  relay: RelayAgentHookServer
  desktop: AgentHookServer
  post: (payload: Record<string, unknown>) => Promise<void>
}

async function startSshPane(): Promise<SshPane> {
  const desktop = new AgentHookServer()
  const relay = new RelayAgentHookServer({
    endpointDir: temporaryDir('orca-relayed-shell-'),
    token: 'relayed-shell-token',
    forward: (envelope) => desktop.ingestRemote(envelope, 'conn-1')
  })
  running.push(relay, desktop)
  await relay.start({ publishEndpoint: false })
  return {
    relay,
    desktop,
    post: async (payload) => {
      const { port, token } = relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    }
  }
}

function row(server: AgentHookServer) {
  const entry = server.getStatusSnapshotForPane(PANE)[0]
  if (!entry) {
    throw new Error('the pane has no row')
  }
  return entry
}

function pressCtrlC(server: AgentHookServer): boolean {
  const baseline = row(server)
  return server.inferInterrupt({
    paneKey: PANE,
    baselineUpdatedAt: baseline.receivedAt,
    baselineStateStartedAt: baseline.stateStartedAt,
    baselinePrompt: baseline.prompt,
    baselineAgentType: 'claude',
    intent: 'ctrl-c'
  })
}

describe('a relayed Ctrl+C in the turn that launched a background shell (captured, 2.1.284)', () => {
  const records = loadCapture('claude-background-shell-ctrl-c-hooks')
  const cancel = cancelLabelled(records, 'S1-ctrl-c-mid-essay')
  const scan = records.find(
    (record): record is CapturedTranscriptScan =>
      record.kind === 'transcript' && record.label === 'queue-operation-enqueue'
  )
  if (!scan) {
    throw new Error('the capture has no enqueue line')
  }
  // JSON.parse returns any; the timestamp is checked by Date.parse.
  const parsed: Record<string, unknown> = JSON.parse(scan.lines[0])
  const t0 = Date.parse(String(parsed.timestamp)) - scan.t * 1000

  async function launchAndCancel(pane: SshPane, transcript: string): Promise<void> {
    for (const index of [0, 1, 2, 3, 4, 5, 6]) {
      vi.setSystemTime(t0 + hookAt(records, index).t * 1000)
      await pane.post({ ...hookAt(records, index).payload, transcript_path: transcript })
    }
    vi.setSystemTime(t0 + cancel.t * 1000)
    expect(pressCtrlC(pane.desktop)).toBe(true)
  }

  it('folds the desktop-inferred cancel to monitoring from the relay-published launch', async () => {
    const pane = await startSshPane()
    const transcript = join(temporaryDir('orca-relayed-shell-transcript-'), 'session.jsonl')
    writeFileSync(transcript, '')
    await launchAndCancel(pane, transcript)
    expect(row(pane.desktop)).toMatchObject({
      state: 'working',
      workingMode: 'monitoring',
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    // The desktop keeps no copy of the relay's record.
    expect(pane.desktop._getStateForTests().claudeNonAgentWorkByPaneKey.has(PANE)).toBe(false)
  })

  it('settles done and interrupted when the relay reads the end line long after the latch window', async () => {
    const pane = await startSshPane()
    const transcript = join(temporaryDir('orca-relayed-shell-transcript-'), 'session.jsonl')
    writeFileSync(transcript, '')
    await launchAndCancel(pane, transcript)
    expect(row(pane.desktop)).toMatchObject({ state: 'working', workingMode: 'monitoring' })
    // Hand-placed timing: the shell ends 20 s after the Ctrl+C with no hook (as a /tasks kill
    // does, r1-s9); the line is the one Claude wrote for this shell when /exit killed it.
    vi.setSystemTime(Date.now() + 20_000)
    appendFileSync(transcript, `${scan.lines[0]}\n`)
    await vi.waitFor(() => expect(row(pane.desktop).workingMode).toBeUndefined(), {
      timeout: 3_000
    })
    // The relay restated its own working main agent; the desktop kept the cancel it inferred.
    expect(
      pane.relay._getStateForTests().lastStatusByPaneKey.get(PANE)?.payload.mainAgent?.state
    ).toBe('working')
    expect(row(pane.desktop)).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
  })
})
