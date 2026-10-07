import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDshStatusPluginSource } from './status-plugin-source'

function agent(parentAgent?: object) {
  const header: { id: string; cwd: string; parentSession?: string; origin?: string } = {
    id: 'lead-session',
    cwd: '/repo'
  }
  return {
    parentAgent,
    status: 'idle',
    inbox: { hasPending: false },
    session: { header }
  }
}

type Agent = ReturnType<typeof agent>
type StatusEvent = { agent: Agent; status: string }

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

async function harness(command = 'orca-hook') {
  vi.stubEnv('ORCA_AGENT_PANE', 'test-pane')
  const frames: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    frames.push(String(chunk))
    return true
  })
  const stdout = Object.create(process.stdout, { isTTY: { value: true, configurable: true } })
  vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout)
  const listeners = new Map<string, (...args: unknown[]) => unknown>()
  let dispose: () => void = () => undefined
  const requests: { command: string; stdin: string; signal: AbortSignal }[] = []
  const source = getDshStatusPluginSource(command)
  const plugin = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )
  plugin.apply({
    effect: (effect: () => () => void) => {
      dispose = effect()
    },
    on: (name: string, callback: (...args: unknown[]) => unknown) => {
      listeners.set(name, callback)
    },
    shell: {
      resolve: (request: (typeof requests)[number]) => request,
      execute: async (request: (typeof requests)[number]) => ({
        result: async () => {
          requests.push(request)
        }
      })
    },
    logger: { warn: vi.fn() }
  })
  const flush = async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }
  }
  return {
    frames,
    emit: (value: StatusEvent) => listeners.get('agent/status')?.(value),
    emitEvent: (name: string, ...args: unknown[]) => listeners.get(name)?.(...args),
    dispose: () => dispose(),
    requests,
    flush
  }
}

describe('native DSH status producer', () => {
  it('preserves lead prompt/tool metadata and passes execution through unchanged', async () => {
    const ctx = await harness()
    const lead = agent()
    const next = vi.fn(async () => ({ kind: 'allow' }))
    await ctx.emitEvent('agent/created', { agent: lead })
    await ctx.emitEvent(
      'agent/pre-step',
      { agent: lead, messages: [{ content: [{ type: 'text', text: 'pick a color' }] }] },
      next
    )
    const exec = {
      agent: lead,
      name: 'ask_user_question',
      arguments: { question: 'Which color?' },
      callId: 'call-1'
    }
    await ctx.emitEvent('tools/pre-execute', exec, next)
    await ctx.emitEvent(
      'tools/post-execute',
      exec,
      { content: [{ type: 'text', text: 'Blue' }] },
      next
    )
    expect(next).toHaveBeenCalledTimes(3)
    const payloads = ctx.requests.map((request) => JSON.parse(request.stdin))
    expect(payloads.map((payload) => payload.hook_event_name)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse'
    ])
    expect(payloads[1].prompt).toBe('pick a color')
    expect(payloads[2]).toMatchObject({
      tool_name: 'ask_user_question',
      tool_input: exec.arguments,
      tool_use_id: 'call-1'
    })
    expect(payloads[3].tool_response).toBe('Blue')
  })

  it('does not forward ordinary child prompt, tool, or completion events', async () => {
    const ctx = await harness()
    const child = agent({})
    const next = vi.fn(async () => ({ kind: 'allow' }))
    await ctx.emitEvent('agent/created', { agent: child })
    await ctx.emitEvent(
      'agent/pre-step',
      { agent: child, messages: [{ content: [{ type: 'text', text: 'child prompt' }] }] },
      next
    )
    await ctx.emitEvent('tools/pre-execute', { agent: child, name: 'read' }, next)
    ctx.emit({ agent: child, status: 'idle' })
    await ctx.flush()
    expect(ctx.requests).toHaveLength(0)
    expect(next).toHaveBeenCalledTimes(2)
  })

  it('sends running then finalized idle in order through the managed transport', async () => {
    const ctx = await harness('hook "with spaces"')
    const lead = agent()
    lead.status = 'running'
    ctx.emit({ agent: lead, status: 'running' })
    await ctx.flush()
    expect(ctx.requests).toHaveLength(1)
    lead.status = 'idle'
    ctx.emit({ agent: lead, status: 'idle' })
    await ctx.flush()
    expect(ctx.requests.map((request) => JSON.parse(request.stdin).hook_event_name)).toEqual([
      'NativeRunning',
      'NativeIdle'
    ])
    expect(ctx.requests[1].command).toBe('hook "with spaces"')
    expect(JSON.parse(ctx.requests[1].stdin).session_id).toBe('lead-session')
  })

  it('posts no completion when a Stop hook steers the still-running turn', async () => {
    const ctx = await harness()
    const lead = agent()
    lead.status = 'running'
    ctx.emit({ agent: lead, status: 'running' })
    await ctx.flush()
    // A pre-finalization Stop does not transition the agent to idle.
    expect(ctx.requests.map((request) => JSON.parse(request.stdin).hook_event_name)).toEqual([
      'NativeRunning'
    ])
  })

  it.each(['live-parent', 'persisted-parent', 'subagent-origin'])(
    'ignores child lifecycle (%s)',
    async (kind) => {
      const ctx = await harness()
      const child = agent(kind === 'live-parent' ? {} : undefined)
      if (kind === 'persisted-parent') {
        child.session.header.parentSession = 'lead-session'
      }
      if (kind === 'subagent-origin') {
        child.session.header.origin = 'subagent'
      }
      ctx.emit({ agent: child, status: 'running' })
      ctx.emit({ agent: child, status: 'idle' })
      await ctx.flush()
      expect(ctx.requests).toHaveLength(0)
    }
  )

  it('suppresses a transient idle immediately followed by a wake-up', async () => {
    const ctx = await harness()
    const lead = agent()
    ctx.emit({ agent: lead, status: 'idle' })
    lead.status = 'running'
    ctx.emit({ agent: lead, status: 'running' })
    await ctx.flush()
    expect(ctx.requests.map((request) => JSON.parse(request.stdin).hook_event_name)).toEqual([
      'NativeRunning'
    ])
  })

  it('does not publish idle while inbox work remains', async () => {
    const ctx = await harness()
    const lead = agent()
    lead.inbox.hasPending = true
    ctx.emit({ agent: lead, status: 'idle' })
    await ctx.flush()
    expect(ctx.requests).toHaveLength(0)
  })

  it('emits ordered PTY state synchronously even while HTTP idle delivery is still queued', async () => {
    const ctx = await harness()
    const lead = agent()
    ctx.emit({ agent: lead, status: 'idle' })
    lead.status = 'running'
    ctx.emit({ agent: lead, status: 'running' })
    expect(ctx.frames.map((frame) => JSON.parse(frame.slice(7, -1)).state)).toEqual([
      'done',
      'working'
    ])
    expect(ctx.requests).toHaveLength(0)
  })

  it('leaves unrelated SDK/headless stdout clean', async () => {
    const ctx = await harness()
    vi.stubEnv('ORCA_AGENT_PANE', '')
    vi.stubEnv('ORCA_PANE_KEY', '')
    ctx.emit({ agent: agent(), status: 'idle' })
    expect(ctx.frames).toEqual([])
  })

  it('leaves piped headless stdout clean even when Orca pane identity is inherited', async () => {
    const ctx = await harness()
    Object.defineProperty(process.stdout, 'isTTY', { value: false })
    ctx.emit({ agent: agent(), status: 'idle' })
    expect(ctx.frames).toEqual([])
  })

  it('drops queued work when the plugin is disposed', async () => {
    const ctx = await harness()
    ctx.emit({ agent: agent(), status: 'idle' })
    ctx.dispose()
    await ctx.flush()
    expect(ctx.requests).toHaveLength(0)
  })
})
