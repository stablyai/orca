import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../../server.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

let server: AgentHookServer | undefined
afterEach(() => {
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
