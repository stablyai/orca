import './orca-runtime-test-lifecycle.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { OrcaRuntimeService } from './orca-runtime'
import { HEADLESS_LEAF_ID, store, TEST_WORKTREE_ID } from './orca-runtime-test-fixtures.spec'
import { AgentHookServer } from '../agent-hooks/server'
import { agentHookRuntimeDeps } from '../agent-hooks/agent-hook-runtime-deps'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'

const PTY_ID = 'pty-jcode-title'
const TAB_ID = 'jcode-title-tab'
const CONVERSATION_WORK =
  '🌐 Fix the caiea bw-scheduler cache permission EPER… · +436 -46 · work ~53m15s'
const CONVERSATION_LAST =
  '🌐 Fix the caiea bw-scheduler cache permission EPER… · +436 -46 · last ~53m15s'
const CONVERSATION_HEAD = '🌐 Fix the caiea bw-scheduler cache permission EPER…'

class TitleStatusRuntime extends OrcaRuntimeService {
  statusForTitle(title: string) {
    return this.classifyPtyTitleStatus(PTY_ID, title)
  }

  resetTitleTracker() {
    this.disposePtyTitleTracker(PTY_ID)
  }

  syntheticTitle(title: string) {
    this.getOrCreatePtyTitleTrackerEntry(PTY_ID).tracker.applySyntheticTitleFrame(
      `\x1b]0;${title}\x07`
    )
  }

  reevaluateTitle(title: string, staleClear = false) {
    this.applyTrackedPtyTitle(
      PTY_ID,
      title,
      title,
      staleClear ? { staleWorkingTitleClear: true } : undefined,
      { statusOnly: !staleClear }
    )
  }

  mirrorRemotePty() {
    const pty = this.ptysById.get(PTY_ID)
    if (pty) {
      pty.connectionId = 'ssh-connection'
    }
  }
}

async function titlePane({
  process = 'jcode-linux-x86_64.bin',
  launchAgent,
  rows = [],
  deps
}: {
  process?: string | null
  launchAgent?: 'jcode' | 'claude'
  rows?: AgentStatusIpcPayload[]
  deps?: NonNullable<ConstructorParameters<typeof OrcaRuntimeService>[2]>
} = {}) {
  const readHookRows = vi.fn((paneKey: string) => rows.filter((row) => row.paneKey === paneKey))
  const runtime = new TitleStatusRuntime(store, undefined, {
    getAgentStatusSnapshot: () => rows,
    getAgentProviderSessionRowsForPane: readHookRows,
    ...deps
  })
  const getForegroundProcess = vi.fn(async () => process)
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
    write: () => true,
    kill: () => true,
    getForegroundProcess
  })
  const terminal = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
    tabId: TAB_ID,
    leafId: HEADLESS_LEAF_ID,
    launchAgent,
    title: 'Terminal'
  })
  const emit = async (data: string): Promise<void> => {
    runtime.onPtyData(PTY_ID, data, Date.now())
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const title = (text: string): Promise<void> => emit(`\x1b]0;${text}\x07`)
  const mobile = async () => {
    const { tabs } = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const tab = tabs.find(
      (candidate) => candidate.type === 'terminal' && candidate.ptyId === PTY_ID
    )
    return tab?.type === 'terminal' ? tab.agentStatus : undefined
  }
  return { runtime, terminal, getForegroundProcess, readHookRows, emit, title, mobile }
}

function hookRow(agentType: 'jcode' | 'claude', state: 'working' | 'done'): AgentStatusIpcPayload {
  return {
    paneKey: `${TAB_ID}:${HEADLESS_LEAF_ID}`,
    tabId: TAB_ID,
    worktreeId: TEST_WORKTREE_ID,
    connectionId: null,
    agentType,
    state,
    prompt: 'Keep hook ownership',
    receivedAt: Date.now() - 100,
    stateStartedAt: Date.now() - 100
  }
}

describe('Jcode native title status in runtime', () => {
  it('projects conversation activity after recognizing the packaged foreground binary', async () => {
    const pane = await titlePane({ launchAgent: 'claude' })
    await pane.runtime.refreshPtyForegroundAgentFromController(PTY_ID)
    expect(pane.getForegroundProcess).toHaveBeenCalledWith(PTY_ID)
    expect((await pane.runtime.listTerminals()).terminals[0]?.agentIdentity).toBe('jcode')

    await pane.title(CONVERSATION_WORK)
    expect(await pane.mobile()).toMatchObject({ agentType: 'jcode', state: 'working' })
    await pane.title(CONVERSATION_LAST)
    expect(await pane.mobile()).toMatchObject({ agentType: 'jcode', state: 'done' })
    await pane.title(CONVERSATION_HEAD)
    expect(await pane.mobile()).toMatchObject({ agentType: 'jcode', state: 'done' })
  })

  it('uses Jcode launch evidence when foreground inspection is unavailable', async () => {
    const pane = await titlePane({ process: null, launchAgent: 'jcode' })
    await pane.title(CONVERSATION_WORK)
    expect(await pane.mobile()).toMatchObject({ agentType: 'jcode', state: 'working' })
    await pane.title(CONVERSATION_LAST)
    expect(await pane.mobile()).toMatchObject({ agentType: 'jcode', state: 'done' })
  })

  it('classifies captured identity titles without foreground or launch evidence', async () => {
    const pane = await titlePane({ process: null })
    await pane.title('🌐 jcode/castle Skunk · +2 -1 · work ~10s')
    expect((await pane.runtime.listTerminals()).terminals[0]?.agentIdentity).toBe('jcode')
    expect(await pane.mobile()).toMatchObject({ agentType: 'jcode', state: 'working' })
    await pane.title('🌐 jcode/castle Skunk · +2 -1 · last ~10s')
    expect(await pane.mobile()).toMatchObject({ agentType: 'jcode', state: 'done' })
  })

  it.each(['zsh', 'claude'])('does not turn task text in a %s pane into Jcode', async (process) => {
    const pane = await titlePane({ process })
    await pane.runtime.refreshPtyForegroundAgentFromController(PTY_ID)
    for (const title of [
      CONVERSATION_WORK,
      CONVERSATION_LAST,
      'Fix jcode hooks',
      '✳ Fix jcode hooks'
    ]) {
      await pane.title(title)
      expect((await pane.runtime.listTerminals()).terminals[0]?.agentIdentity).not.toBe('jcode')
      expect(await pane.mobile()).not.toMatchObject({ agentType: 'jcode' })
    }
  })

  it('preserves program activity precedence over the native duration tail', async () => {
    const pane = await titlePane({ launchAgent: 'jcode' })
    await pane.emit('\x1b]7501;state=working:app=jcode\x1b\\')
    await pane.title('🌐 jcode/castle Skunk · +2 -1 · last ~10s')
    expect(await pane.mobile()).toMatchObject({ state: 'working' })
    await pane.emit('\x1b]7501;state=idle:app=jcode\x1b\\')
    await pane.title('🌐 jcode/castle Skunk · +2 -1 · work ~10s')
    expect(await pane.mobile()).toMatchObject({ state: 'done' })
  })

  it.each(['jcode', 'claude'] as const)(
    'leaves live %s hook status and identity authoritative over Jcode titles',
    async (agent) => {
      const pane = await titlePane({
        launchAgent: agent === 'claude' ? 'jcode' : 'claude',
        rows: [hookRow(agent, 'working')]
      })
      await pane.runtime.refreshPtyForegroundAgentFromController(PTY_ID)
      for (const title of [
        ['🌐 jcode/castle Skunk · +2 -1 · work ~10s', 'working'],
        ['🌐 jcode/castle Skunk · +2 -1 · last ~10s', 'done'],
        [CONVERSATION_LAST, 'done'],
        [CONVERSATION_HEAD, 'done']
      ] as const) {
        const [text, claudeState] = title
        await pane.title(text)
        expect((await pane.runtime.listTerminals()).terminals[0]?.agentIdentity).toBe(agent)
        expect(await pane.mobile()).toMatchObject({
          agentType: agent,
          state: agent === 'jcode' ? 'working' : claudeState
        })
      }
    }
  )

  it('does not reopen a completed Jcode hook turn from a title tail', async () => {
    const pane = await titlePane({ rows: [hookRow('jcode', 'done')] })
    await pane.title('🌐 jcode/castle Skunk · +2 -1 · work ~10s')
    expect(await pane.mobile()).toMatchObject({ agentType: 'jcode', state: 'done' })
  })

  it.each([true, false])(
    'replaces a completed Claude hook without its session, with retained snapshot %s',
    async (retainSnapshot) => {
      const pane = await titlePane({
        launchAgent: 'claude',
        rows: [
          { ...hookRow('claude', 'done'), providerSession: { key: 'session_id', id: 'claude-old' } }
        ],
        deps: retainSnapshot ? undefined : { getAgentStatusSnapshot: () => [] }
      })
      await pane.runtime.refreshPtyForegroundAgentFromController(PTY_ID)
      await pane.title('🌐 jcode/castle Skunk · +2 -1 · work ~10s')
      const status = await pane.mobile()
      expect(status).toMatchObject({ agentType: 'jcode', state: 'working' })
      expect(status?.providerSession).toBeUndefined()
    }
  )

  it.each(['jcode', 'claude'] as const)(
    'keeps base Claude hook arbitration with a %s launch record',
    async (launchAgent) => {
      const pane = await titlePane({ launchAgent, rows: [hookRow('claude', 'working')] })
      await pane.runtime.refreshPtyForegroundAgentFromController(PTY_ID)
      await pane.title('✳ jcode hooks')
      expect((await pane.runtime.listTerminals()).terminals[0]?.agentIdentity).toBe('claude')
      expect(await pane.mobile()).toMatchObject({ agentType: 'claude', state: 'done' })
    }
  )

  it('drops a launch-only Jcode card after a shell reclaims the pane', async () => {
    const pane = await titlePane({ launchAgent: 'jcode', process: 'zsh' })
    await pane.runtime.refreshPtyForegroundAgentFromController(PTY_ID)
    await pane.title('user@host: ~/dev')
    expect(pane.runtime.statusForTitle('user@host: ~/dev')).toBeNull()
    expect(await pane.mobile()).toBeUndefined()
  })

  it('prefers the mobile tab launch record over the PTY launch fallback', async () => {
    const pane = await titlePane({ launchAgent: 'claude', process: null })
    const tab = pane.runtime.mobileSessionTabsByWorktree
      .get(TEST_WORKTREE_ID)
      ?.tabs.find((candidate) => candidate.type === 'terminal' && candidate.ptyId === PTY_ID)
    expect(tab?.type).toBe('terminal')
    if (tab?.type === 'terminal') {
      tab.launchAgent = 'jcode'
    }
    expect(pane.runtime.statusForTitle(CONVERSATION_WORK)).toBe('working')
    await pane.title(CONVERSATION_WORK)
    expect(await pane.mobile()).toMatchObject({ agentType: 'jcode', state: 'working' })
  })

  it.each([
    ['🦨 jcode/castle Skunk', 'idle'],
    ['bash', null],
    ['✳ Fix jcode hooks', 'idle'],
    ['⠋ Fix jcode hooks', 'working'],
    ['⠋ Codex', 'working']
  ] as const)('classifies %j without querying hook ownership', async (title, expected) => {
    const pane = await titlePane()
    pane.readHookRows.mockClear()
    expect(pane.runtime.statusForTitle(title)).toBe(expected)
    expect(pane.readHookRows).not.toHaveBeenCalled()
  })

  it('uses program activity without querying hook ownership', async () => {
    const pane = await titlePane({ launchAgent: 'jcode' })
    await pane.emit('\x1b]7501;state=working:app=jcode\x1b\\')
    pane.readHookRows.mockClear()
    expect(pane.runtime.statusForTitle(CONVERSATION_LAST)).toBe('working')
    expect(pane.readHookRows).not.toHaveBeenCalled()
  })
})

describe('Jcode execution-host title wiring', () => {
  const WORK = '🌐 jcode/castle Skunk · +2 -1 · work ~10s'
  const LAST = '🌐 jcode/castle Skunk · +2 -1 · last ~10s'
  const TURN_C_START = {
    cwd: '/tmp/jcode-capture/work/edit',
    event: 'turn_start',
    model: 'claude-opus-5-5',
    session_id: 'session_skunk_1792604312924_a75443e0fd91bbda',
    source: 'chat'
  }
  let server: AgentHookServer
  let pane: Awaited<ReturnType<typeof titlePane>> | undefined

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(1_000)
    server = new AgentHookServer()
  })

  afterEach(() => {
    pane?.runtime.resetTitleTracker()
    pane = undefined
    server.stop()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function start() {
    const created = await titlePane({
      deps: agentHookRuntimeDeps(server, { read: () => ({ kind: 'unobserved' }) }, () => ({}))
    })
    pane = created
    const event = normalizeHookPayload(
      server._getStateForTests(),
      'jcode',
      {
        paneKey: `${TAB_ID}:${HEADLESS_LEAF_ID}`,
        tabId: TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        env: 'production',
        payload: TURN_C_START
      },
      'production'
    )
    if (!event) {
      throw new Error('missing captured turn start')
    }
    server.ingestRemote(event, null)
    return created
  }

  it.each([WORK, CONVERSATION_WORK])(
    'settles live %j through runtime deps into the mobile projection',
    async (work) => {
      const created = await start()
      await created.title(work)
      await created.title(work === WORK ? LAST : CONVERSATION_LAST)
      vi.advanceTimersByTime(1_999)
      expect(await created.mobile()).toMatchObject({
        agentType: 'jcode',
        state: 'working',
        model: TURN_C_START.model
      })
      vi.advanceTimersByTime(1)
      expect(await created.mobile()).toMatchObject({
        agentType: 'jcode',
        state: 'done',
        model: TURN_C_START.model
      })
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        providerSession: { key: 'session_id', id: TURN_C_START.session_id }
      })
    }
  )

  it.each(['synthetic', 'stale-clear', 'status-only', 'restore', 'remote', 'dispose'])(
    'does not infer from %s title evidence',
    async (source) => {
      const created = await start()
      if (source === 'remote') {
        created.runtime.mirrorRemotePty()
      }
      if (source === 'restore') {
        created.runtime.seedTerminalRestoreTail(PTY_ID, { lastTitle: WORK })
      } else {
        await created.title(WORK)
      }
      if (source === 'synthetic') {
        created.runtime.syntheticTitle(LAST)
      } else if (source === 'stale-clear' || source === 'status-only') {
        created.runtime.reevaluateTitle(LAST, source === 'stale-clear')
      } else {
        await created.title(LAST)
        if (source === 'dispose') {
          created.runtime.resetTitleTracker()
        }
      }
      vi.advanceTimersByTime(2_000)
      expect(server.getStatusSnapshot()[0].state).toBe('working')
    }
  )
})
