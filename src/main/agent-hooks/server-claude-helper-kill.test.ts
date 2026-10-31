import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import { selectFreshExplicitAgentStatus } from '../runtime/runtime-hook-agent-row-selection'
import { selectRuntimeHookAgentRowForPane } from '../runtime/runtime-mobile-agent-status-projection'
import { buildRunningAgentChildRowModels } from '../../shared/running-agent-child-rows'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
const servers: { stop: () => void }[] = []
const folders: string[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

async function host(kind: string, initial: Record<string, unknown>[] = []) {
  // All captured user/assistant/system records survive, including the child interruption after kill.
  const load = async (stream: string): Promise<Record<string, unknown>[]> =>
    (
      await readFile(
        new URL(
          `../../shared/__fixtures__/claude-helper-kill-2.1.310-${stream}.jsonl`,
          import.meta.url
        ),
        'utf8'
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  const parent = await load('parent')
  const child = await load('child')
  const kill = parent.find((record) => record.subtype === 'agents_killed')!
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(String(kill.timestamp)) - 1_000)
  const folder = await mkdtemp(join(tmpdir(), 'claude-kill-host-'))
  folders.push(folder)
  const path = join(folder, 'session.jsonl')
  const lines = (records: Record<string, unknown>[]) =>
    records.map((r) => `${JSON.stringify(r)}\n`).join('')
  await writeFile(path, lines(parent.filter((r) => r !== kill)))
  await mkdir(join(folder, 'session', 'subagents'), { recursive: true })
  await writeFile(join(folder, 'session', 'subagents', 'agent-a123.jsonl'), lines(child))
  const body = (payload: Record<string, unknown>) =>
    buildBody({ session_id: 'session', transcript_path: path, ...payload })
  const desktop = new AgentHookServer()
  const endpointDir = join(folder, 'endpoint')
  if (kind === 'spool') {
    await mkdir(join(endpointDir, 'spool'), { recursive: true })
    await writeFile(
      join(endpointDir, 'spool', 'claude.jsonl'),
      lines(initial.map((p) => ({ ...body(p), source: 'claude', receivedAt: Date.now() })))
    )
  }
  const relay = new RelayAgentHookServer({
    endpointDir,
    token: 'helper-kill-test',
    forward: (e) => desktop.ingestRemote(e, 'connection')
  })
  servers.push(desktop, relay)
  if (kind !== 'local') {
    desktop.subscribeRemoteInterruptRequests(({ request }) => relay.inferInterrupt(request))
  }
  await (kind === 'local'
    ? desktop.start({
        env: 'production',
        userDataPath: folder,
        endpointNamespace: 'lu-claude-helper-kill-test'
      })
    : relay.start({ publishEndpoint: false }))
  async function post(payload: Record<string, unknown>) {
    const { port, token } = relay.getCoordinates()
    const response =
      kind === 'local'
        ? await postHookEvent(desktop, body(payload))
        : await fetch(`http://127.0.0.1:${port}/hook/claude`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
            body: JSON.stringify(body(payload))
          })
    expect(response.status).toBe(204)
  }
  if (kind !== 'spool') {
    for (const payload of initial) {
      await post(payload)
    }
  }
  return {
    desktop,
    relay,
    folder,
    path,
    post,
    kill: () => appendFile(path, lines([kill])),
    row: () => desktop.getStatusSnapshotForPane(PANE)[0]
  }
}

it.each(['local', 'relay', 'spool'])(
  'settles the complete capture on %s through reads, replay and persistence',
  async (kind) => {
    const p = await host(kind, [
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      { hook_event_name: 'SubagentStart', agent_id: 'a123' },
      {
        hook_event_name: 'Stop',
        background_tasks: [
          { id: 'a123', type: 'subagent', status: 'running' },
          { id: 'shell', type: 'shell', status: 'running' }
        ],
        last_assistant_message: 'READY'
      }
    ])
    const before = p.row()
    expect(before?.subagents?.[0]?.state).toBe('working')
    await p.kill()
    await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
      timeout: 5_000,
      interval: 30
    })
    const after = p.row()!
    expect(after.workingMode).toBe('monitoring')
    expect(after.mainAgent).toEqual(before?.mainAgent)
    expect(after.lastAssistantMessage).toBe('READY')
    expect(after.turnEndedAt).toBe(before?.turnEndedAt)
    expect(after.providerSession).toEqual(before?.providerSession)
    const runtime = selectRuntimeHookAgentRowForPane([after])
    expect(runtime.live?.payload.subagents ?? []).toEqual([])
    expect(runtime.live?.payload.mainAgent).toEqual(after.mainAgent)
    expect(
      selectFreshExplicitAgentStatus({ handle: 'terminal', paneKey: PANE, hookRows: [after] })
        ?.status
    ).toBe('working')
    expect(runtime.providerSession).toEqual(after.providerSession)
    expect(
      buildRunningAgentChildRowModels(after, {
        parentEvidenceFresh: true,
        transportObservation: 'live',
        parentObservedAt: after.receivedAt,
        hostClockOffsetMs: 0
      })
    ).toEqual([])
    if (kind !== 'local') {
      p.relay.replayCachedPayloadsForPanes()
      expect(p.row()?.subagents ?? []).toEqual([])
    } else {
      p.desktop.flushStatusPersistSync()
      p.desktop.stop()
      const restored = new AgentHookServer()
      servers.push(restored)
      await restored.start({
        env: 'production',
        userDataPath: p.folder,
        endpointNamespace: 'lu-claude-helper-kill-test'
      })
      const firstPaint = vi.fn()
      restored.setListener(firstPaint)
      expect(firstPaint).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({ subagents: undefined, mainAgent: after.mainAgent })
        })
      )
      expect(restored.getStatusSnapshotForPane(PANE)[0]?.subagents ?? []).toEqual([])
    }
  }
)

it.each(['local', 'relay'])(
  'preserves cancellation through the %s admission and replay',
  async (kind) => {
    const p = await host(kind, [
      { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
      { hook_event_name: 'SubagentStart', agent_id: 'a123' }
    ])
    const baseline = p.row()!
    expect(
      p.desktop.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: baseline.receivedAt,
        baselineStateStartedAt: baseline.stateStartedAt,
        baselinePrompt: baseline.prompt,
        baselineAgentType: 'claude',
        intent: 'ctrl-c'
      })
    ).toBe(true)
    await p.post({
      hook_event_name: 'Stop',
      last_assistant_message: 'READY',
      background_tasks: [{ id: 'a123', type: 'subagent', status: 'running' }]
    })
    const before = p.row()!
    await p.kill()
    await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
      timeout: 5_000,
      interval: 30
    })
    expect(p.row()?.mainAgent).toEqual(before.mainAgent)
    expect(before.mainAgent?.outcome).toBe('cancellation')
    expect(p.row()?.interrupted).toBe(true)
    expect(
      selectFreshExplicitAgentStatus({
        handle: 'terminal',
        paneKey: PANE,
        hookRows: p.desktop.getStatusSnapshotForPane(PANE)
      })?.status
    ).toBe('idle')
    if (kind === 'relay') {
      p.relay.replayCachedPayloadsForPanes()
      expect(p.row()?.mainAgent).toEqual(before.mainAgent)
    }
  }
)

it.each(['hook', 'kill'])('matches child-only ending and wait ownership via %s', async (ending) => {
  for (const owner of ['none', 'a123', 'sibling', 'root']) {
    const p = await host('local', [{ hook_event_name: 'SubagentStart', agent_id: 'a123' }])
    if (owner !== 'none') {
      await p.post({
        hook_event_name: 'PermissionRequest',
        ...(owner === 'root' ? {} : { agent_id: owner }),
        tool_name: 'Bash',
        tool_use_id: 'approval',
        tool_input: { command: 'false' }
      })
    }
    await (ending === 'hook'
      ? p.post({ hook_event_name: 'SubagentStop', agent_id: 'a123' })
      : p.kill())
    await vi.waitFor(
      () => expect(p.row()?.subagents?.some((c) => c.id === 'a123')).not.toBe(true),
      { timeout: 5_000, interval: 30 }
    )
    expect(p.row()?.state).toBe(owner === 'sibling' || owner === 'root' ? 'waiting' : 'working')
    expect(p.row()?.toolName).toBe(owner === 'sibling' || owner === 'root' ? 'Bash' : undefined)
  }
})
