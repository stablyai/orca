import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import { seedLegacyAgentStatusForTests } from '../../shared/agent-hook-listener/listener-state'
import { terminalUsageLimitGuard } from '../../shared/agent-hook-listener/terminal-usage-limit-guard'
import { reduceHostTurnEnd } from '../../shared/agent-hook-turn-end-timing'
import { makePaneKey } from '../../shared/stable-pane-id'
import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE } from '../../shared/native-chat/native-chat-usage-limit-cut'
import type { TuiAgent } from '../../shared/agent-launch/catalog/tui-agent'
import type * as PluginHookDispatch from '../plugins/hooks/plugin-hook-dispatch'
import { AgentHookServer, agentHookServer } from '../agent-hooks/server'
import { TERMINAL_USAGE_LIMIT_METHODS } from './rpc/methods/terminal/terminal-usage-limit-method'

vi.mock('../plugins/hooks/plugin-hook-dispatch', async (original) => ({
  ...(await original<typeof PluginHookDispatch>()),
  pluginHookWanted: (event: string) => event === 'agent.prompt.before',
  runPluginHook: async () => ({ prompt: 'Continue carefully.' })
}))

const PTY = 'pty-terminal-quota'
const HANDLE = 'term_terminal_quota'
const PROMPT = 'Continue carefully.'
const runtimes: OrcaRuntimeService[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
  for (const runtime of runtimes.splice(0)) {
    runtime['disposeHeadlessTerminal'](PTY)
  }
})

async function setup(agent: TuiAgent = 'claude', draft = '') {
  vi.useFakeTimers()
  const runtime = new OrcaRuntimeService()
  runtimes.push(runtime)
  const glyph = agent === 'claude' ? '❯' : '\x1b[1m›\x1b[22m'
  const footer =
    agent === 'claude'
      ? '\r\n──────────────────────────────'
      : '\r\n\r\n  gpt-5-codex · high · /tmp'
  const paint = (text: string) =>
    runtime.onPtyData(
      PTY,
      `\x1b[2J\x1b[H──────────────────────────────\r\n${glyph} ${text}${footer}\x1b[2;${text.length + 3}H`,
      Date.now()
    )
  const write = vi.fn((_ptyId: string, bytes: string): WriteSettlement => {
    runtime.terminalRunFacts.recordInput(PTY, 'orchestration', bytes, 100)
    if (bytes === '\r') {
      runtime.onPtyData(PTY, `\x1b]0;${agent} working\x07`, Date.now())
    } else {
      paint(PROMPT)
    }
    return WRITE_ACCEPTED
  })
  runtime.setPtyController({
    write: () => true,
    writeWithSettlement: write,
    kill: () => true,
    getForegroundProcess: async () => agent
  })
  runtime.registerPty(PTY, 'repo::/tmp/quota', null, {
    tabId: '11111111-1111-4111-8111-111111111111',
    leafId: '22222222-2222-4222-8222-222222222222',
    incarnationId: 'quota-incarnation',
    agentLaunchAuthority: { launchToken: 'quota-launch-token', launchAgent: agent }
  })
  runtime.registerPreAllocatedHandleForPty(PTY, HANDLE)
  runtime.onPtyData(PTY, `\x1b]0;${agent} idle\x07`, Date.now())
  paint(draft)
  await runtime.serializeMainTerminalBuffer(PTY)
  return { runtime, write, paint }
}

it.each(['claude', 'codex'] as const)(
  'submits the plugin-rewritten continuation through %s settlement',
  async (agent) => {
    const { runtime, write } = await setup(agent)
    const result = runtime.continueTerminalUsageLimit(HANDLE, () => true, 'desktop')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toEqual({ status: 'turn-started' })
    expect(write.mock.calls.map(([, bytes]) => bytes)).toEqual([
      expect.stringContaining(PROMPT),
      '\r'
    ])
    expect(write.mock.calls[0][1]).not.toContain(NATIVE_CHAT_USAGE_LIMIT_CONTINUE_MESSAGE)
  }
)

it('writes zero bytes into a draft or a dialog', async () => {
  const { runtime, write, paint } = await setup('claude', 'My unsent question')
  expect(await runtime.continueTerminalUsageLimit(HANDLE, () => true, 'desktop')).toEqual({
    status: 'refused',
    reason: 'draft'
  })
  paint('')
  runtime.onPtyData(PTY, '\x1b[5;1HEnter to select · Esc to cancel\x1b[2;3H', Date.now())
  await runtime.serializeMainTerminalBuffer(PTY)
  expect(await runtime.continueTerminalUsageLimit(HANDLE, () => true, 'desktop')).toEqual({
    status: 'refused',
    reason: 'permission'
  })
  expect(write).not.toHaveBeenCalled()
})

it('leaves pasted text editable when same-clock user input arrives before Enter', async () => {
  const { runtime, write } = await setup()
  const original = write.getMockImplementation()!
  write.mockImplementation((id, bytes) => {
    const result = original(id, bytes)
    runtime.terminalRunFacts.recordInput(PTY, 'driving', 'human input', 100)
    return result
  })
  const result = runtime.continueTerminalUsageLimit(HANDLE, () => true, 'desktop')
  await vi.advanceTimersByTimeAsync(10_000)
  expect(await result).toEqual({ status: 'draft' })
  expect(write).toHaveBeenCalledTimes(1)
})

it('deduplicates simultaneous clicks and never retries an uncertain paste', async () => {
  const { runtime, write } = await setup()
  write.mockReturnValue(writeUnverifiable('transport_settlement_lost', true))
  const result = runtime.continueTerminalUsageLimit(HANDLE, () => true, 'desktop')
  expect(await runtime.continueTerminalUsageLimit(HANDLE, () => true, 'desktop')).toEqual({
    status: 'refused',
    reason: 'in-progress'
  })
  expect(await result).toEqual({ status: 'unknown' })
  expect(write).toHaveBeenCalledTimes(1)
})

it('reports proven refusal without claiming ambiguous delivery', async () => {
  const { runtime, write } = await setup()
  write.mockReturnValue(writeRefused('provider_refused_write'))
  expect(await runtime.continueTerminalUsageLimit(HANDLE, () => true, 'desktop')).toEqual({
    status: 'refused',
    reason: 'unavailable'
  })
  expect(write).toHaveBeenCalledTimes(1)
})

it.each(['before-paste', 'before-enter'] as const)(
  'refreshes guest source %s and never submits past a changed source',
  async (phase) => {
    const { runtime, write } = await setup()
    let reads = 0
    const result = runtime.continueTerminalUsageLimit(
      HANDLE,
      () => true,
      'desktop',
      undefined,
      async () => {
        reads += 1
        return { status: phase === 'before-enter' && reads === 1 ? 'current' : 'changed' }
      }
    )
    await vi.advanceTimersByTimeAsync(10000)
    expect(await result).toEqual(
      phase === 'before-paste' ? { status: 'refused', reason: 'changed' } : { status: 'draft' }
    )
    expect(write).toHaveBeenCalledTimes(phase === 'before-paste' ? 0 : 1)
    expect(reads).toBe(phase === 'before-paste' ? 1 : 2)
  }
)

it('rechecks owner after an asynchronous guest reply before handing off input', async () => {
  const { runtime, write } = await setup()
  let current = true
  const result = runtime.continueTerminalUsageLimit(
    HANDLE,
    () => current,
    'desktop',
    undefined,
    async () => {
      current = false
      return { status: 'current' }
    }
  )
  await vi.advanceTimersByTimeAsync(10000)
  expect(await result).toEqual({ status: 'refused', reason: 'changed' })
  expect(write).not.toHaveBeenCalled()
})

it.each(
  [10, 100].flatMap((panes) =>
    (['settle', 'refuse', 'abort'] as const).map((outcome) => ({ panes, outcome }))
  )
)(
  'retires an attributed root action on $outcome with $panes unrelated panes',
  async ({ panes, outcome }) => {
    const { runtime, write } = await setup('claude', outcome === 'refuse' ? 'Unsent draft' : '')
    const directory = mkdtempSync(join(tmpdir(), 'orca-root-dispatch-'))
    const server = new AgentHookServer()
    try {
      await server.start({ env: 'production', userDataPath: directory })
      const path = join(directory, 'transcript.jsonl')
      const sessionId = '44444444-4444-4444-8444-444444444444'
      const promptId = '33333333-3333-4333-8333-333333333333'
      const paneKey = makePaneKey(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222'
      )
      writeFileSync(
        path,
        `${[
          {
            type: 'user',
            sessionId,
            promptId,
            uuid: 'user',
            parentUuid: null,
            isSidechain: false,
            message: { content: 'Finish' }
          },
          {
            type: 'assistant',
            sessionId,
            uuid: 'quota',
            parentUuid: 'user',
            isSidechain: false,
            apiError: 'usage_limit_reached',
            error: 'rate_limit'
          }
        ]
          .map((row) => JSON.stringify(row))
          .join('\n')}\n`
      )
      const state = server['state']
      const accept = (payload: Record<string, unknown>) => {
        const event = normalizeHookPayload(
          state,
          'claude',
          {
            paneKey,
            payload: {
              session_id: sessionId,
              prompt_id: promptId,
              transcript_path: path,
              ...payload
            }
          },
          'production'
        )!
        const next = {
          ...event,
          ...reduceHostTurnEnd(state.lastStatusByPaneKey.get(paneKey), event, Date.now(), true)
        }
        seedLegacyAgentStatusForTests(state, next)
        return next
      }
      accept({ hook_event_name: 'UserPromptSubmit', prompt: 'Finish' })
      accept({ hook_event_name: 'SubagentStart', agent_id: 'areviewer-1' })
      const failed = accept({ hook_event_name: 'StopFailure', error: 'rate_limit' })
      const cut = { sessionId, turnEndedAt: failed.turnEndedAt! }
      expect(terminalUsageLimitGuard(state, paneKey, cut)).toBeNull()
      const released = accept({ hook_event_name: 'SubagentStop', agent_id: 'areviewer-1' })
      expect(released.toolAgentId).toBe('areviewer-1')
      const unrelated = Array.from({ length: panes }, (_, index) => ({
        ...released,
        paneKey: `unrelated-${index}`,
        receivedAt: Date.now(),
        stateStartedAt: 1
      }))
      for (const row of unrelated) {
        seedLegacyAgentStatusForTests(state, row)
      }
      const baseline = [
        server['enrichedStatusListeners'].size,
        server['paneStatusClearListeners'].size
      ]
      let checks: ReturnType<typeof vi.fn<() => boolean>> | undefined
      const prepare = vi
        .spyOn(agentHookServer, 'prepareTerminalUsageLimitSource')
        .mockImplementation((...args) => {
          const source = server.prepareTerminalUsageLimitSource(...args)
          if (source) {
            checks = vi.fn(source.isCurrent)
            source.isCurrent = checks
          }
          return source
        })
      const controller = new AbortController()
      if (outcome === 'abort') {
        controller.abort()
      }
      const result = TERMINAL_USAGE_LIMIT_METHODS[0].handler(
        { terminal: HANDLE, ...cut, client: { type: 'desktop', id: 'test' } },
        { runtime, signal: controller.signal }
      )
      expect(prepare).toHaveBeenCalledOnce()
      expect(server['enrichedStatusListeners'].size).toBe(baseline[0] + 1)
      expect(server['paneStatusClearListeners'].size).toBe(baseline[1] + 1)
      const beforeUnrelated = checks?.mock.calls.length
      for (const row of unrelated) {
        server['emitEnrichedStatus'](row)
      }
      expect(checks?.mock.calls.length).toBe(beforeUnrelated)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(await result).toEqual(
        outcome === 'settle'
          ? { status: 'turn-started' }
          : { status: 'refused', reason: outcome === 'abort' ? 'unavailable' : 'draft' }
      )
      expect(write.mock.calls.map(([, bytes]) => bytes)).toEqual(
        outcome === 'settle' ? [expect.stringContaining(PROMPT), '\r'] : []
      )
      expect(checks?.mock.calls.length).toBeLessThanOrEqual(8)
      expect(server['enrichedStatusListeners'].size).toBe(baseline[0])
      expect(server['paneStatusClearListeners'].size).toBe(baseline[1])
      expect(runtime['usageLimitContinuations'].size).toBe(0)
    } finally {
      server.stop()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
