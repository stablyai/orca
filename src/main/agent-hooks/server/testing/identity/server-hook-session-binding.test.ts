import '../persistence/last-status.test-fixtures'
import type { BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { HookSessionBindingRendererFixture } from '../../../../../shared/agent-hook-listener/state/agent-hook-session-binding.test-fixture'
import '../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import '../../../../../shared/agent-hook-listener/listener-state'
import '../../../../../shared/agent-status/process/agent-process-presence'
import '../../../../../shared/agent-status/transport/agent-status-legacy-adapter'
import '../../../../../shared/orca-profiles/constants'
import '../../../../../wsl-guest/agent-hooks/publication/agent-hook-envelope-build'
import '../../../../../wsl-guest/agent-hooks/status/agent-hook-provider-normalization'
import '../../../../runtime/session-lifecycle/projection/hook-row-pane-resume-record'
import '../../../../runtime/terminal/stop/hook-status-resume-records'
import {
  installMainWindowAgentStatusListeners,
  clearMainWindowAgentStatusListeners
} from '../../../../startup/main-window/main-window-agent-status'
import { agentHookServer as server } from '../../agent-hook-server'
import { buildBody, postHookEvent } from '../server.test-fixtures'

const bridge = vi.hoisted(() => ({
  send: vi.fn<(channel: string, data: AgentStatusIpcPayload) => void>()
}))
vi.mock('../../../../startup/main-process-state', () => ({
  mainProcessState: { mainWindow: { isDestroyed: () => false, webContents: bridge }, runtime: null }
}))
vi.mock('../../../../window/dashboard-popout-window', () => ({
  getDashboardPopoutWindow: () => null
}))
vi.mock('../../../../startup/main-window/synthetic-title-runtime', () => ({
  stopSyntheticTitleSpinnerTimer: () => {}
}))

const rendererFixture: unknown = await vi.importActual(
  '../../../../../renderer/src/store/slices/agent-status/hook-session-binding-renderer.test-fixture'
)
function isRendererFixture(value: unknown): value is HookSessionBindingRendererFixture {
  return (
    typeof value === 'object' &&
    value !== null &&
    'expectReturnedRenderer' in value &&
    typeof value.expectReturnedRenderer === 'function'
  )
}
if (!isRendererFixture(rendererFixture)) {
  throw new Error('Missing renderer hook binding assertion fixture')
}

const ROOT = 'ordinary-root-B'

let dir: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hook-session-binding-'))
  bridge.send.mockClear()
  await restart()
})
afterEach(() => {
  vi.restoreAllMocks()
  clearMainWindowAgentStatusListeners()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function restart() {
  await server.start({ env: 'production', userDataPath: dir })
  installMainWindowAgentStatusListeners({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only mocked WebContents is used; window is an unused option.
    window: {} as BrowserWindow,
    onRecordAgentState: () => {}
  })
}
async function post(source: 'hermes' | 'codex' | 'antigravity', payload: Record<string, unknown>) {
  expect((await postHookEvent(server, buildBody(payload), `/hook/${source}`)).status).toBe(204)
}
function frame() {
  const call = bridge.send.mock.calls.findLast(([channel]) => channel === 'agentStatus:set')
  if (!call) {
    throw new Error('No main-window status publication')
  }
  return call[1]
}
async function positive(id = ROOT) {
  await post('hermes', {
    hook_event_name: 'pre_llm_call',
    session_id: id,
    platform: 'cli',
    user_message: 'continue'
  })
}

async function nested() {
  await post('codex', {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'nested-codex',
    prompt: 'review'
  })
  expect(frame()).toMatchObject({
    agentType: 'codex',
    state: 'working',
    providerSession: { id: 'nested-codex' }
  })
}
async function tool(id = ROOT) {
  await post('hermes', {
    hook_event_name: 'post_tool_call',
    session_id: id,
    tool_name: 'delegate_task'
  })
}

it('keeps root-own completion terminal even when its binding matches', async () => {
  await positive()
  await post('hermes', { hook_event_name: 'post_llm_call', session_id: ROOT, platform: 'cli' })
  await nested()
  await tool()
  expect(frame().agentType).toBe('codex')
})
