import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS } from '../../../program-status/hook-precedence'
import { buildBody, ingestProgramStatusOsc, PANE, postHookEvent } from '../../server.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

let server: AgentHookServer | undefined
afterEach(() => {
  vi.useRealTimers()
  server?.stop()
})

function oscStatus(state: 'working' | 'done'): void {
  // OpenCode 2 reports OSC 7501 as `app=opencode`.
  server!.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { state, prompt: '', agentType: 'opencode' }
  })
}

async function hook(hook_event_name: string, prompt = ''): Promise<void> {
  const body = buildBody({ hook_event_name, sessionID: 'ses_opencode2', prompt })
  expect((await postHookEvent(server!, body, '/hook/opencode2')).status).toBe(204)
}

it('keeps OpenCode 2 hooks and their session on a pane its OSC 7501 reports as opencode', async () => {
  server = new AgentHookServer()
  await server.start({ env: 'production' })
  oscStatus('working')
  await hook('SessionBusy', 'rename the branch')
  expect(server.getStatusSnapshot()[0]).toMatchObject({
    agentType: 'opencode2',
    prompt: 'rename the branch'
  })

  await hook('SessionIdle')
  oscStatus('done')
  expect(server.getStatusSnapshot()[0]).toMatchObject({
    agentType: 'opencode2',
    state: 'done',
    providerSession: { id: 'ses_opencode2' }
  })
})

it('keeps an idle OpenCode 2 pane done while another session in its folder works', async () => {
  server = new AgentHookServer()
  await server.start({ env: 'production' })
  await hook('SessionBusy', 'rename the branch')
  await hook('SessionIdle')

  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.advanceTimersByTime(1)
  // Captured from an idle OpenCode 2.2.6 TUI while another TUI in its folder ran a turn.
  const otherSession = Buffer.from('Title PARENTSPAWN').toString('base64')
  ingestProgramStatusOsc(
    server,
    `\x1b]7501;state=working:app=opencode:title=${otherSession}\x1b\\` +
      `\x1b]7501;state=working:id=ses_e37f56b97ffeLXB4e0RO7uYUBV:app=opencode:title=${otherSession}\x1b\\`
  )
  vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)

  expect(server.getStatusSnapshot()[0]).toMatchObject({
    state: 'done',
    providerSession: { id: 'ses_opencode2' }
  })
})

it('keeps a permission prompt from another OpenCode session off a working pane', async () => {
  server = new AgentHookServer()
  await server.start({ env: 'production' })
  await hook('SessionBusy', 'rename the branch')

  const request = Buffer.from('rm -rf build').toString('base64')
  ingestProgramStatusOsc(
    server,
    `\x1b]7501;state=blocked:kind=permission:app=opencode:msg=${request}\x1b\\` +
      `\x1b]7501;state=blocked:kind=permission:id=ses_other:app=opencode:msg=${request}\x1b\\`
  )

  const [row] = server.getStatusSnapshot()
  expect(row).toMatchObject({ state: 'working' })
  expect(row?.programStatus).toBeUndefined()
})
