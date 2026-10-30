import type { BrowserWindow } from 'electron'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type { HookSessionBindingRendererFixture } from '../../shared/agent-hook-session-binding.test-fixture'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import {
  createHookListenerState,
  admitLegacyAgentStatus
} from '../../shared/agent-hook-listener/listener-state'
import { readAgentProcessPresence } from '../../shared/agent-process-presence'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../shared/agent-status-legacy-adapter'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { buildRelayHookEnvelope } from '../../wsl-guest/agent-hook-envelope-build'
import { RelayProviderHookNormalization } from '../../wsl-guest/agent-hook-provider-normalization'
import { hookRowPaneResumeRecord } from '../runtime/session-lifecycle/projection/hook-row-pane-resume-record'
import {
  hookStatusResumeCommand,
  quitResumeRecords,
  resumeStatusFromHookRow
} from '../runtime/terminal/stop/hook-status-resume-records'
import {
  installMainWindowAgentStatusListeners,
  clearMainWindowAgentStatusListeners
} from '../startup/main-window-agent-status'
import { agentHookServer as server } from './server'
import { buildBody, PANE, GOOD_PANE, postHookEvent } from './server.test-fixtures'

const bridge = vi.hoisted(() => ({
  send: vi.fn<(channel: string, data: AgentStatusIpcPayload) => void>()
}))
vi.mock('../startup/main-process-state', () => ({
  mainProcessState: { mainWindow: { isDestroyed: () => false, webContents: bridge }, runtime: null }
}))
vi.mock('../window/dashboard-popout-window', () => ({ getDashboardPopoutWindow: () => null }))
vi.mock('../startup/synthetic-title-runtime', () => ({ stopSyntheticTitleSpinnerTimer: () => {} }))

const rendererFixture: unknown = await vi.importActual(
  '../../renderer/src/store/slices/agent-status/hook-session-binding-renderer.test-fixture'
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
const { expectReturnedRenderer } = rendererFixture

const ROOT = 'ordinary-root-B'
const CHILD = 'delegated-child-A'
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
async function childDone() {
  await post('hermes', { hook_event_name: 'pre_llm_call', session_id: CHILD, platform: 'subagent' })
  await post('hermes', { hook_event_name: 'on_session_end', session_id: CHILD })
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
function expectReturned(id = ROOT, agent: 'hermes' | 'antigravity' = 'hermes') {
  const data = frame()
  expect(data).toMatchObject({
    agentType: agent,
    state: 'working',
    providerSession: { id },
    paneOwner: { agent, session: id }
  })
  expect(server.getStatusSnapshot()[0]?.providerSession?.id).toBe(id)
  const tab = expectReturnedRenderer(data, id, agent, PANE, 'wt-1')
  const status = resumeStatusFromHookRow(data, undefined)
  if (!status) {
    throw new Error('No host resume status')
  }
  const session = { ...getDefaultWorkspaceSession(), tabsByWorktree: { 'wt-1': [tab] } }
  const checkpoint = hookStatusResumeCommand({
    status,
    session,
    worktreeId: 'wt-1',
    launchConfigOf: () => undefined
  })
  expect(checkpoint?.type === 'sleep' && checkpoint.records[0]?.providerSession.id).toBe(id)
  expect(
    quitResumeRecords({
      statuses: [status],
      session,
      worktreeIdOf: () => 'wt-1',
      launchConfigOf: () => undefined,
      capturedAt: data.receivedAt
    })[0]?.providerSession.id
  ).toBe(id)
  expect(
    hookRowPaneResumeRecord({ rows: [data], worktreeId: 'wt-1', tab })?.providerSession.id
  ).toBe(id)
}

it.each(['sessionless', 'replacement', 'positive-after-foreign'] as const)(
  'settles the complete HTTP parent iteration after %s',
  async (mode) => {
    await post('hermes', {
      hook_event_name: 'pre_tool_call',
      session_id: ROOT,
      tool_name: 'read_file'
    })
    expect(frame().paneOwner).toBeUndefined()
    const id = mode === 'sessionless' ? ROOT : mode === 'replacement' ? CHILD : 'successor-C'
    if (mode === 'replacement') {
      await positive(ROOT)
      await childDone()
      await nested()
    }
    if (mode === 'positive-after-foreign') {
      await post('hermes', { hook_event_name: 'on_session_end', session_id: ROOT })
      await nested()
    }
    await positive(id)
    expect(frame().paneOwner?.session).toBe(id)
    // A different child avoids completing the renewed root when it was formerly a child itself.
    await post('hermes', {
      hook_event_name: 'pre_llm_call',
      session_id: 'new-helper',
      platform: 'subagent'
    })
    await post('hermes', { hook_event_name: 'on_session_end', session_id: 'new-helper' })
    expect(frame().state).toBe('done')
    await nested()
    await tool('unrecognized-child')
    expect(frame().agentType).toBe('codex')
    await tool(id)
    expectReturned(id)
    if (mode === 'sessionless') {
      await childDone()
      await nested()
    }
    server.stop()
    await restart()
    await tool(id)
    expectReturned(id)
  }
)

it('keeps root-own completion terminal even when its binding matches', async () => {
  await positive()
  await post('hermes', { hook_event_name: 'post_llm_call', session_id: ROOT, platform: 'cli' })
  await nested()
  await tool()
  expect(frame().agentType).toBe('codex')
})

it('retires the binding on an actual host clear, including through a later foreign row', async () => {
  await positive()
  await childDone()
  server.ingestTerminalStatus({
    paneKey: PANE,
    worktreeId: 'wt-1',
    origin: 'process',
    payload: { agentType: 'hermes', state: 'working', prompt: '' }
  })
  expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  expect(frame().paneOwner).toBeUndefined()
  await post('hermes', { hook_event_name: 'on_session_end', session_id: CHILD })
  await nested()
  await tool()
  expect(frame().agentType).toBe('codex')
  server.stop()
  await restart()
  await tool()
  expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  await positive('fresh-C')
  await childDone()
  await nested()
  await tool('fresh-C')
  expectReturned('fresh-C')
  server.recordLaunchResumeIdentity({
    paneKey: PANE,
    worktreeId: 'wt-1',
    agentType: 'hermes',
    providerSession: { key: 'session_id', id: 'explicit-seed' },
    launchedAt: frame().receivedAt + 1
  })
  await tool('explicit-seed')
  expectReturned('explicit-seed')
})

it.each([257, 512])(
  'matches only the actual hook against a %s-character unproven legacy tuple after hydration',
  async (length) => {
    const id = 'l'.repeat(length)
    await positive('b'.repeat(length))
    expect(frame().providerSession?.id).toHaveLength(length)
    await childDone()
    await nested()
    server.stop()
    // Exact legacy representation: a helper ID with no positive observation of its own.
    const path = join(dir, 'agent-hooks', 'last-status.json')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    saved.entries[PANE].agentPresence.session = id
    writeFileSync(path, JSON.stringify(saved))
    await restart()
    await tool('different-session')
    expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
    await tool(id)
    expectReturned(id)
    expect(readAgentProcessPresence({ agent: 'hermes', session: id })?.session).toBe(id)
    expect(readAgentProcessPresence({ agent: 'antigravity', session: id })?.session).toBe(id)
    expect(readAgentProcessPresence({ agent: 'codex', session: id })?.session).toBeUndefined()
  }
)

it('reenters Antigravity from retained first-record authority when that file is temporarily unreadable', async () => {
  const transcriptPath = join(dir, 'agy.jsonl')
  const origin = {
    step_index: 0,
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    content: 'Reply with OK.'
  }
  const hook = (id: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: 'PreInvocation',
    conversationId: id,
    transcriptPath,
    lastUserInput: 'Reply with OK.',
    ...extra
  })
  writeFileSync(transcriptPath, `${JSON.stringify(origin)}\n`)
  await post('antigravity', hook(ROOT))
  await post(
    'antigravity',
    hook(ROOT, {
      hook_event_name: 'Stop',
      fullyIdle: true,
      terminationReason: 'NO_TOOL_CALL',
      error: ''
    })
  )
  await nested()
  const beforeRejectedRoot = server.getStatusSnapshot()
  await post('antigravity', hook('rejected-C', { hook_event_name: 'SessionStart' }))
  expect(server.getStatusSnapshot()).toEqual(beforeRejectedRoot)
  rmSync(transcriptPath)
  await post('antigravity', hook('child-A'))
  expect(frame().agentType).toBe('codex')
  await post('antigravity', hook(ROOT))
  expectReturned(ROOT, 'antigravity')
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'sender=parent' })}\n`
  )
  const cold = normalizeHookPayload(
    createHookListenerState(),
    'antigravity',
    buildBody(hook('child-A')),
    'production'
  )
  expect(cold?.providerSession).toBeUndefined()
})

it('forwards a cold host comparison to the retained canonical binding without creating one', async () => {
  await positive()
  await childDone()
  await nested()
  const build = (id: string) => {
    const canonical = createHookListenerState()
    const event = new RelayProviderHookNormalization().normalize(
      canonical,
      'hermes',
      buildBody({ hook_event_name: 'post_tool_call', session_id: id, tool_name: 'delegate_task' }),
      'production'
    )
    if (!event) {
      throw new Error('No cold execution-host tool event')
    }
    return buildRelayHookEnvelope(event, 'hermes', 'production')
  }
  for (const id of ['child-A', ROOT]) {
    const envelope = build(id)
    expect(envelope.agentPresence).toEqual({ agent: 'hermes', session: id })
    expect(envelope.providerSession).toBeUndefined()
    server.ingestRemote(envelope, null)
    expect(frame().agentType).toBe(id === ROOT ? 'hermes' : 'codex')
  }
  expectReturned()
  server.clearPaneState(PANE)
  server.ingestRemote(build('unknown-child'), null)
  expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  expect(frame().paneOwner).toBeUndefined()
})

it('rejects before mutating provider folds and validates scoped IDs with the locator parser', () => {
  const now = 1_700_000_000_000
  vi.spyOn(Date, 'now').mockReturnValue(now)
  const state = createHookListenerState()
  const previous = {
    paneKey: PANE,
    worktreeId: 'wt-1',
    connectionId: null,
    hostEvidenceObservedAt: now,
    agentPresence: { agent: 'hermes', session: ROOT },
    payload: { agentType: 'codex', state: 'working' as const, prompt: 'review' }
  }
  admitLegacyAgentStatus(
    state,
    'main-status-update',
    previous,
    AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
  )
  const body = buildBody({
    hook_event_name: 'pre_tool_call',
    session_id: 'mismatch',
    tool_name: 'write_file',
    user_message: 'poison'
  })
  expect(normalizeHookPayload(state, 'hermes', body, 'production')).toBeNull()
  expect(state.lastPromptByPaneKey.size).toBe(0)
  expect(state.lastToolByPaneKey.size).toBe(0)
  expect(state.hermesTurnByPaneKey.size).toBe(0)
  for (const session of ['x'.repeat(513), '-option', 'bad\nidentity']) {
    expect(readAgentProcessPresence({ agent: 'hermes', session })?.session).toBeUndefined()
    expect(readAgentProcessPresence({ agent: 'antigravity', session })?.session).toBeUndefined()
  }
})

it.each([
  { connectionId: 'other-host', worktreeId: 'wt-1', paneKey: PANE, tabId: 'tab-1' },
  { connectionId: null, worktreeId: 'other-worktree', paneKey: PANE, tabId: 'tab-1' },
  { connectionId: null, worktreeId: 'wt-1', paneKey: GOOD_PANE, tabId: 'tab-good' }
])('does not project a binding across terminal scope %j', async (scope) => {
  await positive()
  await childDone()
  await nested()
  const event = normalizeHookPayload(
    createHookListenerState(),
    'hermes',
    buildBody({ hook_event_name: 'post_tool_call', session_id: ROOT, tool_name: 'delegate_task' }),
    'production'
  )
  if (!event) {
    throw new Error('Missing scope test tool')
  }
  server.ingestRemote({ ...buildRelayHookEnvelope(event, 'hermes'), ...scope }, scope.connectionId)
  const rows = server.getStatusSnapshotForPane(scope.paneKey)
  expect(rows[0]?.providerSession).toBeUndefined()
})

it('does not let positive authority bypass a different proven process owner', async () => {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody({ hook_event_name: 'UserPromptSubmit', session_id: 'claude-owner', prompt: 'work' }),
    'production'
  )
  if (!event) {
    throw new Error('Missing Claude owner event')
  }
  server.ingestRemote(
    {
      ...event,
      agentPresence: {
        agent: 'claude',
        sessionOwner: true,
        process: { pid: 99, platform: 'linux', startTime: 'start' }
      }
    },
    null
  )
  await positive('cannot-steal')
  expect(server.getStatusSnapshot()[0]).toMatchObject({
    agentType: 'claude',
    providerSession: { id: 'claude-owner' }
  })
})
