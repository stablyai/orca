// Claude Code 2.1.302 No/Escape captures; only identities and probe paths were scrubbed.
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { agentVerdictDisplayMark } from '../../shared/agent-main-agent-verdict'
import { hookRowAgentPhase } from '../../shared/agent-transitions'
import { createProgramStatusProjector } from '../../shared/program-status/agent-status-projector'
import { RelayAgentHookServer } from '../../wsl-guest/agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../shared/agent-hook-relay'
import { AgentHookServer } from './server'
import { AgentTranscriptPollScheduler } from '../../shared/agent-transcript-poll-scheduler'
import { buildBody, PANE, GOOD_PANE, postHookEvent } from './server.test-fixtures'

const SESSION = '00000000-0000-4000-8000-000000000000'
const directories: string[] = []
const servers: { stop: () => void }[] = []

function capture(action: string) {
  const lines = readFileSync(
    join(__dirname, '../../shared/__fixtures__', `claude-permission-${action}.jsonl`),
    'utf8'
  )
    .trim()
    .split('\n')
  const assistant = z
    .object({
      message: z.object({
        content: z.array(
          z.object({ id: z.string(), name: z.string(), input: z.record(z.string(), z.unknown()) })
        )
      })
    })
    .parse(JSON.parse(lines[0]))
  const tool = assistant.message.content[0]
  if (!tool) {
    throw new Error('capture has no tool request')
  }
  return { lines, tool }
}

async function setup(remote = false) {
  const dir = mkdtempSync(join(tmpdir(), 'orca-permission-result-'))
  directories.push(dir)
  const transcript = join(dir, 'session.jsonl')
  writeFileSync(transcript, '')
  const desktop = new AgentHookServer()
  servers.push(desktop)
  let connected = true
  const forwarded: AgentHookRelayEnvelope[] = []
  const relay = remote
    ? new RelayAgentHookServer({
        endpointDir: dir,
        token: 'permission-result-test',
        forward: (envelope) => {
          forwarded.push(envelope)
          if (connected) {
            desktop.ingestRemote(envelope, 'conn-1')
          }
        }
      })
    : undefined
  if (relay) {
    servers.push(relay)
    await relay.start({ publishEndpoint: false })
  } else {
    await desktop.start({ env: 'production' })
  }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
  const post = async (payload: Record<string, unknown>) => {
    const body = buildBody({ session_id: SESSION, transcript_path: transcript, ...payload })
    if (!relay) {
      expect((await postHookEvent(desktop, body)).status).toBe(204)
    } else {
      const { port, token } = relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token,
          Connection: 'close'
        },
        body: JSON.stringify(body)
      })
      expect(response.status).toBe(204)
    }
  }
  return {
    desktop,
    relay,
    transcript,
    forwarded,
    post,
    disconnect: () => {
      connected = false
    },
    reconnect: () => {
      connected = true
      relay?.replayCachedPayloadsForPanes()
    },
    row: () => desktop.getStatusSnapshotForPane(PANE)[0],
    tick: () => vi.advanceTimersByTimeAsync(5_001)
  }
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function permission(
  pane: Awaited<ReturnType<typeof setup>>,
  tool: ReturnType<typeof capture>['tool'],
  extra: Record<string, unknown> = {}
) {
  await pane.post({
    hook_event_name: 'PreToolUse',
    tool_name: tool.name,
    tool_input: tool.input,
    tool_use_id: tool.id
  })
  // Real PermissionRequest omits tool_use_id; the execution host must bind it before replacing PreToolUse.
  await pane.post({
    hook_event_name: 'PermissionRequest',
    tool_name: tool.name,
    tool_input: tool.input,
    ...extra
  })
}

function line(row: Record<string, unknown>) {
  return `${JSON.stringify(row)}\n`
}

describe('Claude permission result observation', () => {
  it.each([
    { action: 'decline', remote: false },
    { action: 'escape', remote: false },
    { action: 'decline', remote: true },
    { action: 'escape', remote: true }
  ])(
    'settles recorded $action on the execution host (relay=$remote) without resurrecting the tool',
    async ({ action, remote }) => {
      const pane = await setup(remote)
      const { lines, tool } = capture(action)
      // A result can flush before HTTP admission; initial catch-up must include it.
      writeFileSync(pane.transcript, `${lines.slice(0, remote ? 1 : lines.length).join('\n')}\n`)
      await pane.post({ hook_event_name: 'UserPromptSubmit', prompt: 'run the permission probe' })
      await permission(pane, tool)
      expect(pane.row()).toMatchObject({ state: 'waiting', toolName: 'Bash' })
      expect(hookRowAgentPhase(pane.row()!)).toBe('needs-you')
      const terminal = readFileSync(
        join(__dirname, '../../shared/__fixtures__', `claude-permission-${action}.txt`),
        'utf8'
      )
      const native = createProgramStatusProjector().process(terminal)
      expect(native.payloads.at(-1)?.payload.state).toBe('done')
      for (const report of native.payloads) {
        pane.desktop.ingestTerminalStatus({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          connectionId: remote ? 'conn-1' : null,
          fromProgramStatus: true,
          payload: report.payload
        })
      }
      expect(pane.row()?.state).toBe('waiting')
      await pane.post({ hook_event_name: 'Notification', notification_type: 'permission_prompt' })
      await pane.post({
        hook_event_name: 'SubagentStart',
        agent_id: 'child',
        agent_type: 'Explore'
      })
      if (remote) {
        pane.disconnect()
        appendFileSync(pane.transcript, `${lines.slice(1).join('\n')}\n`)
      }
      await pane.tick()
      if (remote) {
        expect(pane.row()?.state).toBe('waiting')
        expect(pane.forwarded.at(-1)).toMatchObject({
          claudeSettledRequests: [{ toolUseId: tool.id }],
          payload: { state: 'working', mainAgent: { outcome: 'cancellation' } }
        })
        // Another hook overwrites the relay's one cached row before reconnect.
        await pane.post({
          hook_event_name: 'SubagentStart',
          agent_id: 'another-child',
          agent_type: 'Explore'
        })
        pane.reconnect()
      }
      expect(pane.row()).toMatchObject({
        state: 'working',
        prompt: 'run the permission probe',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      })
      expect(pane.row()?.toolName).toBeUndefined()
      expect(pane.row()?.interactivePrompt).toBeUndefined()
      await pane.post({ hook_event_name: 'SubagentStop', agent_id: 'child' })
      if (remote) {
        await pane.post({ hook_event_name: 'SubagentStop', agent_id: 'another-child' })
      }
      expect(pane.row()).toMatchObject({
        state: 'done',
        interrupted: true,
        mainAgent: { outcome: 'cancellation' }
      })
      expect(pane.row()?.toolName).toBeUndefined()
      expect(agentVerdictDisplayMark(pane.row()!)).toBe('interrupted')
    }
  )

  it('releases a declined request during continued work, then applies a late complete interruption record over the live relay', async () => {
    const pane = await setup(true)
    const { lines, tool } = capture('decline')
    writeFileSync(pane.transcript, `${lines[0]}\n`)
    await permission(pane, tool)
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting') // An overlay/native idle without a result is no decision.
    appendFileSync(pane.transcript, `${lines.slice(1, 3).join('\n')}\n`)
    await pane.tick()
    expect(pane.row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
    expect(pane.row()?.mainAgent?.outcome).toBeUndefined()
    expect(pane.row()?.interactivePrompt).toBeUndefined()
    await pane.post({ hook_event_name: 'SubagentStart', agent_id: 'child' })
    expect(pane.row()?.toolName).toBeUndefined()
    appendFileSync(pane.transcript, `${lines[3]}\n${lines[4]}`)
    await pane.tick()
    expect(pane.row()?.mainAgent?.state).toBe('working')
    appendFileSync(pane.transcript, `\n${lines[5]}\n`)
    await pane.tick()
    expect(pane.row()?.mainAgent).toMatchObject({ state: 'done', outcome: 'cancellation' })
  })

  it('keeps Q2 and child-owned permissions when Q1 settles, and rejects ambiguous full-input binding', async () => {
    const pane = await setup()
    const { lines, tool } = capture('decline')
    writeFileSync(pane.transcript, `${lines[0]}\n`)
    await permission(pane, tool)
    const rejected = z.record(z.string(), z.unknown()).parse(JSON.parse(lines[2]))
    appendFileSync(
      pane.transcript,
      line({ ...rejected, type: 'api-request-blob' }) +
        line({ ...rejected, isSidechain: true }) +
        line({ ...rejected, sessionId: 'other-session', session_id: 'other-session' })
    )
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting')
    const second = { ...tool, id: 'tool-2', input: { command: 'second request' } }
    const assistant = {
      type: 'assistant',
      isSidechain: false,
      sessionId: SESSION,
      uuid: 'second-assistant',
      parentUuid: 'decline2-node-1',
      message: { role: 'assistant', content: [{ type: 'tool_use', ...second }] }
    }
    appendFileSync(pane.transcript, line(assistant))
    await permission(pane, second)
    await pane.post({
      hook_event_name: 'PreToolUse',
      tool_name: tool.name,
      tool_input: tool.input,
      tool_use_id: tool.id
    })
    expect(pane.row()).toMatchObject({ state: 'waiting', toolInput: 'second request' })
    appendFileSync(pane.transcript, `${lines.slice(1).join('\n')}\n`)
    await pane.tick()
    expect(pane.row()).toMatchObject({ state: 'waiting', toolInput: 'second request' })
    await permission(pane, tool, { agent_id: 'child', tool_use_id: tool.id })
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting')
    expect(pane.row()?.toolName).toBe('Bash')
    // Separate assistant envelopes can contain indistinguishable parallel requests.
    await pane.post({ hook_event_name: 'SessionStart', source: 'startup' })
    writeFileSync(
      pane.transcript,
      `${lines[0]}\n${line({
        ...assistant,
        message: { role: 'assistant', content: [{ type: 'tool_use', ...tool, id: 'ambiguous' }] }
      })}`
    )
    await permission(pane, tool)
    appendFileSync(pane.transcript, `${lines.slice(1).join('\n')}\n`)
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting')
  })

  it.each([false, true])(
    'binds a unique Q2 flushed after its ID-less hook (relay=%s)',
    async (remote) => {
      const pane = await setup(remote)
      const { lines, tool } = capture('escape')
      writeFileSync(pane.transcript, `${lines[0]}\n`)
      await permission(pane, tool)
      const second = { ...tool, id: 'late-q2', input: { command: 'second request' } }
      await permission(pane, second)
      await pane.tick()
      expect(pane.row()).toMatchObject({ state: 'waiting', toolInput: 'second request' })
      const q2 = lines.map((raw) =>
        raw
          .replaceAll(tool.id, second.id)
          .replaceAll('escape2-node-', 'q2-node-')
          .replaceAll(JSON.stringify(tool.input), JSON.stringify(second.input))
      )
      // Its request and result flush together after registration, without another hook.
      appendFileSync(pane.transcript, `${q2.join('\n')}\n`)
      await pane.tick()
      await pane.tick() // Admit identity first, then the exact settlement through the same matcher.
      expect(pane.row()).toMatchObject({ state: 'done', interrupted: true })
      expect(agentVerdictDisplayMark(pane.row()!)).toBe('interrupted')
      await pane.post({ hook_event_name: 'SubagentStart', agent_id: 'refresh' })
      expect(pane.row()?.toolName).toBeUndefined()
      // A new ID-less request without a fresh PreToolUse cannot reuse Q2's historical result.
      await pane.post({
        hook_event_name: 'PermissionRequest',
        tool_name: second.name,
        tool_input: second.input
      })
      await pane.tick()
      expect(pane.row()).toMatchObject({ state: 'waiting', toolName: 'Bash' })
    }
  )

  it.each([false, true])(
    'does not pin a new request to an unverified preceding tool (relay=%s)',
    async (remote) => {
      const pane = await setup(remote)
      const { lines, tool } = capture('escape')
      writeFileSync(pane.transcript, `${lines[0]}\n`)
      await pane.post({
        hook_event_name: 'PreToolUse',
        tool_name: tool.name,
        tool_input: tool.input,
        tool_use_id: tool.id
      })
      const input = { command: 'different unflushed request' }
      await pane.post({
        hook_event_name: 'PermissionRequest',
        tool_name: tool.name,
        tool_input: input
      })
      await pane.tick()
      expect(pane.row()?.state).toBe('waiting')
      const next = lines.map((raw) =>
        raw
          .replaceAll(tool.id, 'different-tool')
          .replaceAll('escape2-node-', 'different-node-')
          .replaceAll(JSON.stringify(tool.input), JSON.stringify(input))
      )
      appendFileSync(pane.transcript, `${next.join('\n')}\n`)
      await pane.tick()
      await pane.tick()
      expect(pane.row()).toMatchObject({ state: 'done', interrupted: true })
    }
  )

  it.each([false, true])(
    'settles Q1 without an old verdict when P2 precedes its hook (relay=%s)',
    async (remote) => {
      const pane = await setup(remote)
      const { lines, tool } = capture('escape')
      writeFileSync(pane.transcript, `${lines[0]}\n`)
      await permission(pane, tool)
      const root = { isSidechain: false, sessionId: SESSION, promptId: remote ? undefined : 'p2' }
      const nextPrompt = {
        ...root,
        type: 'user',
        uuid: 'p2-user',
        parentUuid: 'escape2-node-6',
        message: {
          role: 'user',
          content: remote ? 'Continue working' : [{ type: 'text', text: 'Continue working' }]
        }
      }
      const nextAssistant = {
        ...root,
        type: 'assistant',
        uuid: 'p2-assistant',
        parentUuid: 'p2-user',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Continuing' }] }
      }
      appendFileSync(
        pane.transcript,
        `${lines.slice(1).join('\n')}\n${line(nextPrompt)}${line(nextAssistant)}`
      )
      if (remote) {
        pane.disconnect()
      }
      await pane.tick()
      if (remote) {
        pane.reconnect()
      }
      expect(pane.row()).toMatchObject({ state: 'working', mainAgent: { state: 'working' } })
      expect(pane.row()?.mainAgent?.outcome).toBeUndefined()
      expect(pane.row()?.toolName).toBeUndefined()
      expect(agentVerdictDisplayMark(pane.row()!)).toBeNull()
      await pane.post({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'Continue working',
        prompt_id: 'p2'
      })
      await pane.tick()
      expect(pane.row()).toMatchObject({ state: 'working', prompt: 'Continue working' })
    }
  )

  it.each([false, true])(
    'settles only proved Q1 after proof exhaustion, including recovered identity (relay=%s)',
    async (remote) => {
      for (const recovered of [false, true]) {
        const pane = await setup(remote)
        const { lines, tool } = capture('escape')
        await pane.post({ hook_event_name: 'UserPromptSubmit', prompt: 'original prompt' })
        writeFileSync(pane.transcript, recovered ? '' : `${lines[0]}\n`)
        await permission(pane, tool)
        await pane.post({ hook_event_name: 'SubagentStart', agent_id: 'child' })
        const suffix = Array.from({ length: 520 }, (_, i) =>
          line({
            type: 'attachment',
            isSidechain: false,
            sessionId: SESSION,
            uuid: `cap-${i}`,
            parentUuid: i ? `cap-${i - 1}` : 'escape2-node-6'
          })
        ).join('')
        appendFileSync(
          pane.transcript,
          `${lines.slice(recovered ? 0 : 1).join('\n')}\n${suffix}${line({
            type: 'user',
            isSidechain: false,
            sessionId: SESSION,
            uuid: 'p2-cap',
            parentUuid: 'cap-519',
            promptId: 'p2',
            message: { content: 'Continue working' }
          })}${line({
            type: 'assistant',
            isSidechain: false,
            sessionId: SESSION,
            uuid: 'p2-response',
            parentUuid: 'p2-cap',
            promptId: 'p2',
            message: { content: [{ type: 'text', text: 'Working' }] }
          })}`
        )
        const clear = vi.spyOn(AgentTranscriptPollScheduler.prototype, 'clear')
        if (remote && !recovered) {
          pane.disconnect()
        }
        await pane.tick()
        expect(clear).toHaveBeenCalledWith(PANE)
        if (remote) {
          expect(pane.forwarded.at(-1)).toMatchObject({
            claudeSettledRequests: [{ toolUseId: tool.id }],
            payload: { mainAgent: { state: 'working' } }
          })
          pane.reconnect()
        }
        expect(pane.row()).toMatchObject({
          state: 'working',
          prompt: 'original prompt',
          mainAgent: { state: 'working' },
          subagents: [expect.objectContaining({ id: 'child' })]
        })
        expect(pane.row()?.mainAgent?.outcome).toBeUndefined()
        expect(pane.row()?.toolName).toBeUndefined()
        const schedules = vi.spyOn(AgentTranscriptPollScheduler.prototype, 'schedule')
        appendFileSync(pane.transcript, `${lines[4]}\n${lines[5]}\n`)
        await pane.tick()
        expect(schedules).not.toHaveBeenCalled()
        expect(pane.row()?.mainAgent?.state).toBe('working')
        schedules.mockRestore()
        clear.mockRestore()
        await pane.post({ hook_event_name: 'SubagentStop', agent_id: 'child' })
        expect(pane.row()?.toolName).toBeUndefined()
        expect(pane.row()?.mainAgent?.state).toBe('working')
      }
    }
  )

  it('does not settle an ID-less desktop wait when its recovered binding was missed while disconnected', async () => {
    const pane = await setup(true)
    const { lines, tool } = capture('escape')
    await permission(pane, tool)
    await pane.post({ hook_event_name: 'SubagentStart', agent_id: 'child' })
    pane.disconnect()
    appendFileSync(pane.transcript, `${lines.slice(0, 3).join('\n')}\n`)
    await pane.tick()
    await pane.tick()
    expect(pane.forwarded.at(-1)).toMatchObject({
      claudeSettledRequests: [{ toolUseId: tool.id }],
      payload: { mainAgent: { state: 'working' } }
    })
    pane.reconnect()
    expect(pane.row()?.state).toBe('waiting') // Missing receiver identity is uncovered, never guessed.
  })

  it('keeps the exact observation when a live terminal moves to another pane', async () => {
    const pane = await setup()
    const { lines, tool } = capture('escape')
    writeFileSync(pane.transcript, `${lines[0]}\n`)
    await permission(pane, tool)
    pane.desktop.transferPaneAuthority(PANE, GOOD_PANE, 'moving-pty')
    appendFileSync(pane.transcript, `${lines.slice(1).join('\n')}\n`)
    await pane.tick()
    expect(pane.desktop.getStatusSnapshotForPane(GOOD_PANE)[0]).toMatchObject({
      state: 'done',
      interrupted: true
    })
    expect(pane.desktop.getStatusSnapshotForPane(PANE)).toHaveLength(0)
  })

  it('re-anchors after file replacement and never combines evidence across a missing record', async () => {
    const pane = await setup()
    const { lines, tool } = capture('escape')
    writeFileSync(pane.transcript, `${lines[0]}\n`)
    await permission(pane, tool)
    const replacement = `${pane.transcript}.replacement`
    writeFileSync(replacement, `${lines.slice(1).join('\n')}\n`)
    renameSync(replacement, pane.transcript)
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting')
    writeFileSync(pane.transcript, `${lines[0]}\n`)
    await permission(pane, tool)
    writeFileSync(
      pane.transcript,
      `${lines.slice(0, 3).join('\n')}\nnot-json\n${lines.slice(3).join('\n')}\n`
    )
    await pane.tick()
    expect(pane.row()?.state).toBe('waiting')
    // Lost proof retires; a fresh request observation can recover a complete replacement.
    writeFileSync(pane.transcript, `${lines[0]}\n`)
    await permission(pane, tool)
    writeFileSync(replacement, `${lines.join('\n')}\n`)
    renameSync(replacement, pane.transcript)
    await pane.tick()
    expect(pane.row()).toMatchObject({ state: 'done', interrupted: true })
    await pane.post({ hook_event_name: 'UserPromptSubmit', prompt: 'new turn' })
    await pane.tick()
    expect(pane.row()).toMatchObject({ state: 'working', prompt: 'new turn' })
    expect(pane.row()?.mainAgent?.outcome).toBeUndefined()
  })
})
