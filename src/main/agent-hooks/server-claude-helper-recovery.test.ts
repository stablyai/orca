import { appendFileSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { ClaudeHelperKillPoller } from '../../shared/agent-hook-listener/providers/claude-helper-kill-poller'
import { ClaudeTranscriptDecoder } from '../../shared/agent-hook-listener/providers/claude-transcript-decoder'
import * as cursor from '../../shared/agent-hook-listener/providers/claude-transcript-cursor'
import { AgentTranscriptPollScheduler } from '../../shared/agent-transcript-poll-scheduler'

// Complete captured lifecycle records, with runtime replay seeded by real persisted HTTP state.
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
  // Only exact test-created mkdtemp paths; no external state is reachable.
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
const lines = (records: Record<string, unknown>[]) =>
  records.map((r) => `${JSON.stringify(r)}\n`).join('')
// ast-grep-ignore: test-no-real-time-wait -- Real elapsed gaps separate hook R, provider K and restart S.
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function load(stream: string): Promise<Record<string, unknown>[]> {
  return (
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
}
const hooks = [
  { hook_event_name: 'UserPromptSubmit', prompt: 'work' },
  { hook_event_name: 'SubagentStart', agent_id: 'a123' },
  {
    hook_event_name: 'Stop',
    last_assistant_message: 'READY',
    background_tasks: [
      { id: 'a123', type: 'subagent', status: 'running' },
      { id: 'shell', type: 'shell', status: 'running' }
    ]
  }
]

async function setup(
  kind: string,
  when: string,
  options: {
    cutoff?: number
    killAt?: number
    throwOnce?: boolean
    disabled?: boolean
    paneCount?: number
    beforeStart?: (transcript: string) => void
    admitted?: () => void
    retryBind?: boolean
    busyPort?: number
    stopBeforeBind?: boolean
    advanceBeforeBind?: () => void
    retired?: boolean
  } = {}
) {
  const inputHooks = options.throwOnce ? [hooks[1]] : hooks
  const parent = await load('parent'),
    child = await load('child')
  let oldKill = parent.find((r) => r.subtype === 'agents_killed')!
  const folder = await mkdtemp(join(tmpdir(), 'pr35930-c5-bounded-'))
  folders.push(folder)
  const transcript = join(folder, 'session.jsonl')
  await writeFile(transcript, lines(parent.filter((r) => r !== oldKill)))
  await mkdir(join(folder, 'session', 'subagents'), { recursive: true })
  await writeFile(join(folder, 'session', 'subagents', 'agent-a123.jsonl'), lines(child))
  const body = (payload: Record<string, unknown>) =>
    buildBody(
      { session_id: 'session', transcript_path: transcript, ...payload },
      { launchToken: 'same-owner' }
    )
  const endpointDir =
    kind === 'desktop-spool' ? join(folder, 'agent-hooks', 'c5-bounded') : join(folder, 'endpoint')
  const startOptions = { env: 'production', userDataPath: folder, endpointNamespace: 'c5-bounded' }
  // Desktop restart is seeded by actual HTTP admission/persistence, not injected snapshot roster.
  if (kind === 'desktop-spool') {
    const previous = new AgentHookServer()
    servers.push(previous)
    await previous.start(startOptions)
    for (let i = 0; i < (options.paneCount ?? 1); i++) {
      for (const h of inputHooks) {
        expect(
          (
            await postHookEvent(previous, {
              ...body(h),
              paneKey: i === 0 ? PANE : PANE.slice(0, -12) + (i + 1).toString(16).padStart(12, '0')
            })
          ).status
        ).toBe(204)
      }
    }
    expect(previous.getStatusSnapshotForPane(PANE)[0]?.subagents?.[0]?.state).toBe('working')
    previous.flushStatusPersistSync()
    previous.stop()
  }
  if (kind.endsWith('spool')) {
    await mkdir(join(endpointDir, 'spool'), { recursive: true })
    // Actual failed-hook emission while stopped: use the shell writer's second floor.
    const receivedAt = options.cutoff ?? Math.floor(Date.now() / 1000) * 1000
    await writeFile(
      join(endpointDir, 'spool', 'claude.jsonl'),
      lines(
        Array.from({ length: options.paneCount ?? 1 }, (_, i) =>
          inputHooks.map((h) => ({
            ...body(h),
            paneKey: i === 0 ? PANE : PANE.slice(0, -12) + (i + 1).toString(16).padStart(12, '0'),
            source: 'claude',
            launchToken: 'same-owner',
            receivedAt
          }))
        ).flat()
      )
    )
  }
  if (when === 'before-start') {
    // ast-grep-ignore: test-no-real-time-wait -- Provider K must follow failed-hook R with real I/O.
    await pause(5)
    oldKill = { ...oldKill, timestamp: new Date(options.killAt ?? Date.now()).toISOString() }
    await appendFile(transcript, lines([oldKill]))
    // ast-grep-ignore: test-no-real-time-wait -- Restart S must follow provider K without mocking host time.
    await pause(20)
  }
  options.beforeStart?.(transcript)
  const desktop = new AgentHookServer()
  servers.push(desktop)
  if (options.retired) {
    desktop.dropStatusEntriesByTabPrefix('tab-1')
  }
  let prebind = false,
    threw = false,
    starting = true
  const beforeBind = () => {
    if (when === 'accepted-before-bind' && !prebind) {
      prebind = true
      appendFileSync(
        transcript,
        lines([{ ...oldKill, timestamp: new Date(Date.now()).toISOString() }])
      )
      options.advanceBeforeBind?.()
      if (options.stopBeforeBind) {
        if (kind.startsWith('desktop')) {
          desktop.stop()
        } else {
          relay.stop()
        }
      }
    }
  }
  desktop.setListener((event) => {
    if (kind === 'desktop-spool' && starting) {
      options.admitted?.()
    }
    if (options.throwOnce && !threw && event.hookEventName === 'SubagentStart') {
      threw = true
      appendFileSync(
        transcript,
        lines([{ ...oldKill, timestamp: new Date(Date.now()).toISOString() }])
      )
      throw new Error('test outward listener')
    }
    if (event.hookEventName !== 'Stop') {
      return
    }
    if (kind === 'desktop-spool') {
      if (!options.disabled) {
        expect(desktop['server']).toBe(null)
      }
      beforeBind()
    }
  })
  const relay = new RelayAgentHookServer({
    endpointDir,
    token: 'c5-bounded',
    preferredPort: options.retryBind ? -1 : options.busyPort,
    isPaneSurfaceRetired: () => options.retired === true,
    forward: (e) => {
      if (kind === 'relay-spool' && starting) {
        options.admitted?.()
      }
      desktop.ingestRemote(e, 'connection')
      if (kind === 'relay-spool' && e.hookEventName === 'Stop') {
        beforeBind()
      }
    }
  })
  servers.push(relay)
  const start = () =>
    kind.startsWith('desktop')
      ? desktop.start({ ...startOptions, statusHooksEnabled: !options.disabled })
      : relay.start({ publishEndpoint: false })
  if (options.retryBind || (options.throwOnce && kind === 'desktop-spool')) {
    await expect(start()).rejects.toThrow()
    const observer = kind.startsWith('desktop')
      ? desktop['claudeHelperKills']
      : relay['retryScheduler']['claudeHelperKills']
    const retained = observer['observations'].get(PANE)!
    expect(retained.parent.offset).toBe(0)
    expect(observer['scheduler']['entries'].size).toBe(0)
    if (options.retryBind) {
      Reflect.set(relay, 'preferredPort', 0)
    }
    await start()
    expect(observer['observations'].get(PANE)).toBe(retained)
  } else {
    await start()
  }
  starting = false
  const post = async (payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    if (kind.startsWith('desktop')) {
      expect((await postHookEvent(desktop, { ...body(payload), ...extra })).status).toBe(204)
    } else {
      const { port, token } = relay.getCoordinates()
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/hook/claude`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
            body: JSON.stringify({ ...body(payload), ...extra })
          })
        ).status
      ).toBe(204)
    }
  }
  if (!kind.endsWith('spool')) {
    for (const h of inputHooks) {
      await post(h)
    }
  }
  const poller = kind.startsWith('desktop')
    ? desktop['claudeHelperKills']
    : relay['retryScheduler']['claudeHelperKills']
  const entries = poller['observations']
  return {
    desktop,
    relay,
    poller,
    post,
    transcript,
    oldKill,
    entries,
    prebind,
    threw,
    row: () => desktop.getStatusSnapshotForPane(PANE)[0]
  }
}

it.each([
  ['relay-spool', 'before-start'],
  ['relay-spool', 'accepted-before-bind'],
  ['desktop-spool', 'before-start'],
  ['desktop-spool', 'accepted-before-bind']
])('delivers the first kill through %s %s, then wakes retained evidence', async (kind, when) => {
  const clock =
    when === 'accepted-before-bind' ? vi.spyOn(Date, 'now').mockReturnValue(Date.now()) : undefined
  const acceptedAt = Date.now()
  const p = await setup(kind, when, {
    advanceBeforeBind: () => clock?.mockReturnValue(acceptedAt + 10)
  })
  const before = p.row()!
  await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
    timeout: 3000,
    interval: 30
  })
  expect(p.row()?.workingMode).toBe('monitoring')
  expect(p.row()?.mainAgent).toEqual(before.mainAgent)
  expect(p.row()?.lastAssistantMessage).toBe('READY')
  expect(p.row()?.turnEndedAt).toBe(before.turnEndedAt)
  const owner = p.entries.get(PANE)!
  const offset = owner.parent.offset
  // A delayed hook is the legitimate parked wake. No second kill is appended.
  await p.post(hooks[1])
  await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
    timeout: 3000,
    interval: 30
  })
  expect(p.entries.get(PANE)).toBe(owner)
  expect(owner.parent.offset).toBe(offset)
  if (when === 'accepted-before-bind') {
    expect(p.prebind).toBe(true)
  }
})

it.each(['desktop-http', 'relay-http', 'desktop-spool', 'relay-spool'])(
  'retains accepted observation when %s fanout throws',
  async (kind) => {
    const p = await setup(kind, 'accepted-before-bind', { throwOnce: true })
    expect(p.threw).toBe(true)
    expect(p.entries.size).toBe(1)
    await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
      timeout: 3000,
      interval: 30
    })
    expect(p.row()?.state).toBe('working') // Unknown root remains live; no parent hook was supplied.
  }
)

it.each(['relay-spool', 'desktop-spool'])(
  'keeps history and genuine within-second generations on %s',
  async (kind) => {
    const R = Math.floor(Date.now() / 1000) * 1000
    const p = await setup(kind, 'before-start', { cutoff: R, killAt: R - 1001 })
    await vi.waitFor(() => expect(p.entries.get(PANE)?.parent.offset).toBeGreaterThan(0), {
      timeout: 3000,
      interval: 30
    })
    expect(p.entries.get(PANE)?.killedAt).toBeUndefined()
    expect(p.row()?.subagents?.[0]?.state).toBe('working')
    const child = join(p.transcript.slice(0, -6), 'subagents', 'agent-a123.jsonl')
    await appendFile(
      child,
      lines([
        {
          type: 'user',
          timestamp: new Date(R + 520).toISOString(),
          message: { content: [{ type: 'text', text: 'Resume the work' }] }
        }
      ])
    )
    await appendFile(
      p.transcript,
      lines([{ ...p.oldKill, timestamp: new Date(R + 500).toISOString() }])
    )
    await vi.waitFor(() => expect(p.entries.get(PANE)?.killedAt).toBe(R + 500), {
      timeout: 3000,
      interval: 30
    })
    expect(p.row()?.subagents?.[0]?.state).toBe('working')
    // R's precision admits K, but only provider generation decides whether this work ends.
    await appendFile(
      p.transcript,
      lines([{ ...p.oldKill, timestamp: new Date(R + 600).toISOString() }])
    )
    await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
      timeout: 3000,
      interval: 30
    })
  }
)

it('initialization of an already-listening desktop activates parked runtime spool', async () => {
  const p = await setup('desktop-spool', 'before-start', { disabled: true })
  expect(p.entries.size).toBe(0)
  p.desktop.setStatusHooksEnabled(true)
  await vi.waitFor(
    () => {
      expect(p.entries.size).toBe(1)
      expect(p.row()?.subagents ?? []).toEqual([])
      expect(p.row()?.workingMode).toBe('monitoring')
    },
    { timeout: 3000, interval: 30 }
  )
})

it('caps future spool cutoffs and keeps HTTP cutoff provenance private', async () => {
  const S = Date.now()
  const p = await setup('relay-spool', 'before-start', { cutoff: S + 60000 })
  expect(p.entries.get(PANE)?.observedAt).toBeLessThan(S + 60000)
  await appendFile(p.transcript, lines([{ ...p.oldKill, timestamp: new Date().toISOString() }]))
  await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
    timeout: 3000,
    interval: 30
  })
  const q = await setup('desktop-http', 'after-start')
  await q.post(hooks[2], { receivedAt: 0, hookReceivedAt: 0 })
  expect(q.entries.get(PANE)?.observedAt).toBeGreaterThan(S - 1000)
  await appendFile(
    q.transcript,
    lines([{ ...q.oldKill, timestamp: new Date(S - 10000).toISOString() }])
  )
  await vi.waitFor(() => expect(q.entries.get(PANE)?.parent.offset).toBeGreaterThan(0), {
    timeout: 3000,
    interval: 30
  })
  expect(q.row()?.subagents?.[0]?.state).toBe('working')
})

it.each(['relay-spool', 'desktop-spool'])(
  'bounds actual admitted trigger and activation at N/10N on %s',
  async (kind) => {
    const measurements: {
      N: number
      captures: number
      activations: number
      reads: number
      parentBytes: number
      tokens: number
      batches: number
      head: number
    }[] = []
    for (const N of [10, 100]) {
      let tokens = 0,
        batches = 0,
        head = 0
      const write = ClaudeTranscriptDecoder.prototype.write
      const decoding = vi
        .spyOn(ClaudeTranscriptDecoder.prototype, 'write')
        .mockImplementation(function (this: ClaudeTranscriptDecoder, text, input) {
          const before = this['tokens']
          write.call(this, text, input)
          tokens += this['tokens'] - before
          batches++
          head = Math.max(head, this['head'].length)
          expect(text.length).toBeLessThanOrEqual(64 * 1024)
        })
      const read = vi.spyOn(cursor, 'readClaudeTranscriptChunk')
      const capture = vi.spyOn(ClaudeHelperKillPoller.prototype, 'schedule')
      const activate = vi.spyOn(ClaudeHelperKillPoller.prototype, 'activate')
      const arm = vi.spyOn(AgentTranscriptPollScheduler.prototype, 'schedule')
      let accepted = 0
      const p = await setup(kind, 'accepted-before-bind', {
        paneCount: N,
        beforeStart: (transcript) => {
          // Valid oversized ordinary input follows the same uniform decoder on every admitted owner.
          appendFileSync(transcript, lines([{ type: 'attachment', content: 'x'.repeat(300_000) }]))
          tokens = batches = head = 0
          decoding.mockClear()
          read.mockClear()
          capture.mockClear()
          activate.mockClear()
          arm.mockClear()
        },
        admitted: () => {
          accepted++
          // These are spies over real methods, never substitutes for a production loop step.
          expect(read).not.toHaveBeenCalled()
          expect(decoding).not.toHaveBeenCalled()
          expect(arm).not.toHaveBeenCalled()
        }
      })
      expect(accepted).toBe(3 * N)
      expect(capture).toHaveBeenCalledTimes(3 * N)
      expect(p.entries.size).toBe(N)
      expect(activate.mock.calls.length).toBeLessThanOrEqual(2)
      expect(arm).toHaveBeenCalledTimes(N)
      const first = [...p.entries.values()]
      p.poller.activate()
      p.poller.activate()
      expect([...p.entries.values()]).toEqual(first)
      expect(p.poller['scheduler']['entries'].size).toBe(N)
      await vi.waitFor(
        () => {
          expect(p.row()?.subagents ?? []).toEqual([])
          for (const entry of p.entries.values()) {
            expect(entry.killedAt).toBeDefined()
          }
          expect(p.poller['scheduler']['entries'].size).toBe(0)
          expect(p.poller['scheduler']['deadlines']['timer']).toBeUndefined()
        },
        { timeout: 5000, interval: 30 }
      )
      expect(read.mock.calls.length).toBeLessThanOrEqual(3 * N)
      const offsets = [...p.entries.values()].reduce((sum, e) => sum + e.parent.offset, 0)
      for (const entry of p.entries.values()) {
        expect(entry.parent.decoder['head'].length).toBeLessThanOrEqual(320)
      }
      measurements.push({
        N,
        captures: capture.mock.calls.length,
        activations: activate.mock.calls.length,
        reads: read.mock.calls.length,
        parentBytes: offsets,
        tokens,
        batches,
        head
      })
      expect(tokens).toBeGreaterThan(0)
      expect(head).toBeLessThanOrEqual(320)
      p.desktop.stop()
      p.relay.stop()
      expect(p.entries.size).toBe(0)
      decoding.mockRestore()
      read.mockRestore()
      capture.mockRestore()
      activate.mockRestore()
      arm.mockRestore()
    }
    expect(measurements[1].captures).toBe(10 * measurements[0].captures)
    expect(measurements[1].parentBytes).toBe(10 * measurements[0].parentBytes)
    expect(measurements[1].tokens).toBe(10 * measurements[0].tokens)
    expect(measurements[1].batches).toBe(10 * measurements[0].batches)
    process.stdout.write(`admitted owner contract ${kind} ${JSON.stringify(measurements)}\n`)
  }
)

it('a real failed bind parks without resources and explicit retry delivers its first fact', async () => {
  const p = await setup('relay-spool', 'before-start', { retryBind: true })
  await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
    timeout: 3000,
    interval: 30
  })
  expect(p.row()?.workingMode).toBe('monitoring')
})

it.each(['relay-spool', 'desktop-spool'])(
  'stop during %s recovery invalidates its parked owner',
  async (kind) => {
    const read = vi.spyOn(cursor, 'readClaudeTranscriptChunk')
    const p = await setup(kind, 'accepted-before-bind', {
      stopBeforeBind: true,
      beforeStart: () => read.mockClear()
    })
    expect(p.entries.size).toBe(0)
    expect(read).not.toHaveBeenCalled()
    expect(p.poller['scheduler']['entries'].size).toBe(0)
  }
)

it.each(['desktop-http', 'relay-http', 'desktop-spool', 'relay-spool'])(
  'refused %s admission creates no observation or wake',
  async (kind) => {
    const capture = vi.spyOn(ClaudeHelperKillPoller.prototype, 'schedule')
    const p = await setup(kind, 'before-start', {
      retired: true,
      beforeStart: () => capture.mockClear()
    })
    expect(p.entries.size).toBe(0)
    expect(capture).not.toHaveBeenCalled()
    if (kind === 'desktop-spool') {
      expect(p.row()?.restoredUnconfirmed).toBe(true)
    } else {
      expect(p.row()).toBeUndefined()
    }
  }
)

it('a held local child permission cannot reset the admitted owner', async () => {
  const p = await setup('desktop-http', 'after-start')
  await p.post({
    hook_event_name: 'PermissionRequest',
    agent_id: 'a123',
    tool_name: 'Bash',
    tool_use_id: 'approval',
    tool_input: { command: 'false' }
  })
  const owner = p.entries.get(PANE)
  const capture = vi.spyOn(ClaudeHelperKillPoller.prototype, 'schedule')
  await p.post({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'unrelated',
    tool_input: { command: 'true' }
  })
  expect(p.row()?.state).toBe('waiting')
  expect(capture).not.toHaveBeenCalled()
  expect(p.entries.get(PANE)).toBe(owner)
  await appendFile(p.transcript, lines([{ ...p.oldKill, timestamp: new Date().toISOString() }]))
  await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
    timeout: 3000,
    interval: 30
  })
})

it('preferred-port fallback activates the original admitted observation', async () => {
  const busy = createServer()
  await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve))
  try {
    const address = busy.address()
    if (!address || typeof address === 'string') {
      throw new Error('missing listener address')
    }
    const p = await setup('relay-spool', 'before-start', { busyPort: address.port })
    expect(p.relay.usedPortFallback).toBe(true)
    await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
      timeout: 3000,
      interval: 30
    })
    expect(p.row()?.workingMode).toBe('monitoring')
  } finally {
    await new Promise<void>((resolve) => busy.close(() => resolve()))
  }
})

it.each(['desktop-http', 'relay-http'])(
  'cached SessionStart activation on %s keeps its boundary and first later kill',
  async (kind) => {
    const p = await setup(kind, 'after-start')
    const S = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(S)
    await p.post({ hook_event_name: 'SessionStart', source: 'resume' })
    const owner = p.entries.get(PANE)!
    expect(owner.observedAt).toBe(S)
    clock.mockReturnValue(S + 10)
    p.poller.activate()
    p.poller.activate()
    expect(p.entries.get(PANE)).toBe(owner)
    expect(owner.observedAt).toBe(S)
    await p.post(hooks[1])
    await appendFile(
      p.transcript,
      lines([{ ...p.oldKill, timestamp: new Date(S + 1).toISOString() }])
    )
    await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
      timeout: 3000,
      interval: 30
    })
  }
)

it('reentrant mirror and OSC writes cannot borrow local hook admission', async () => {
  const p = await setup('desktop-http', 'after-start')
  const other = PANE.replace('111111111111', '222222222222')
  let reentered = false
  p.desktop.subscribeStatusRowMutations(() => {
    if (reentered) {
      return
    }
    reentered = true
    p.desktop.ingestRemote(
      {
        paneKey: other,
        providerSession: { key: 'session_id', id: 'other', transcriptPath: p.transcript },
        payload: { agentType: 'claude', state: 'working' }
      },
      'other-host'
    )
    p.desktop.ingestTerminalStatus({
      paneKey: other,
      payload: { agentType: 'claude', state: 'working', prompt: '' }
    })
  })
  await p.post({ hook_event_name: 'UserPromptSubmit', prompt: 'another real turn' })
  expect(reentered).toBe(true)
  expect(p.entries.size).toBe(1)
  expect(p.desktop.getStatusSnapshotForPane(other)[0]?.state).toBe('working')
  await appendFile(p.transcript, lines([{ ...p.oldKill, timestamp: new Date().toISOString() }]))
  await vi.waitFor(() => expect(p.row()?.subagents ?? []).toEqual([]), {
    timeout: 3000,
    interval: 30
  })
})
