import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import { HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS } from './server/program-status/hook-precedence'
import { resolveProgramStatusPresentation } from '../../shared/program-status/presentation'

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'orca-program-status-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  vi.useRealTimers()
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

function programStatus(
  payload: Omit<ParsedAgentStatusPayload, 'prompt'>,
  extra: { removesProgramStatusRow?: true; renewsProgramStatusLease?: true } = {}
): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', ...payload },
    ...extra
  })
}

async function openCodeHook(hookEventName: string): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({ hook_event_name: hookEventName, sessionID: 'ses_1' }),
    '/hook/opencode'
  )
  expect(response.status).toBe(204)
}

function paneRow() {
  return server.getStatusSnapshotForPane(PANE)[0]
}

describe('OSC 7501 status beside hooks', () => {
  it('drives the pane on its own when no hook reports it', () => {
    programStatus({ state: 'working', agentType: 'claude', toolInput: 'Fixing the parser' })
    expect(paneRow()).toMatchObject({
      state: 'working',
      agentType: 'claude',
      toolInput: 'Fixing the parser'
    })
    programStatus({ state: 'waiting', agentType: 'claude' })
    expect(paneRow()?.state).toBe('waiting')
  })

  it('yields to the same agent once its hooks own the row', async () => {
    await openCodeHook('SessionBusy')
    programStatus({ state: 'done', agentType: 'opencode' })
    expect(paneRow()?.state).toBe('working')
    programStatus({ state: 'done' })
    expect(paneRow()?.state).toBe('working')
  })

  it('yields to a mid-turn hook row even under another app id', async () => {
    await openCodeHook('SessionBusy')
    programStatus({ state: 'done', agentType: 'claude' })
    expect(paneRow()).toMatchObject({ state: 'working', agentType: 'opencode' })
  })

  it('takes over when a different program reports after the hook agent finished', async () => {
    await openCodeHook('SessionIdle')
    programStatus({ state: 'working', agentType: 'terraform' })
    expect(paneRow()).toMatchObject({ state: 'working', agentType: 'terraform' })
  })

  it('never blocks a later hook event', async () => {
    programStatus({ state: 'working', agentType: 'opencode' })
    await openCodeHook('SessionIdle')
    expect(paneRow()?.state).toBe('done')
  })

  it('falls back to OSC 7501 once hooks go silent on a state the program has left', async () => {
    await openCodeHook('SessionBusy')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS)
    programStatus({ state: 'working', agentType: 'opencode' })
    expect(paneRow()?.state).toBe('working')
    programStatus({ state: 'done', agentType: 'opencode' })
    expect(paneRow()?.state).toBe('done')
    vi.useRealTimers()
    await openCodeHook('SessionBusy')
    expect(paneRow()?.state).toBe('working')
  })

  it('re-offers a settled report once the hooks fall silent, without the program resending it', async () => {
    await openCodeHook('SessionBusy')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    programStatus({ state: 'done', agentType: 'opencode' })
    expect(paneRow()?.state).toBe('working')
    vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
    expect(paneRow()?.state).toBe('done')
  })

  it('never settles a later hook turn with a report that yielded to an earlier one', async () => {
    await openCodeHook('SessionBusy')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    programStatus({ state: 'done', agentType: 'opencode' })
    vi.advanceTimersByTime(1_000)
    await openCodeHook('SessionBusy')
    vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
    expect(paneRow()?.state).toBe('working')
  })

  it('removes a row only OSC wrote once the program leaves no records, and tells the window', async () => {
    const cleared: string[] = []
    server.setPaneStatusClearListener((event) =>
      cleared.push('paneKey' in event && event.programStatusRemoved ? event.paneKey : '')
    )
    programStatus({ state: 'done', agentType: 'brew' })
    programStatus(
      { state: 'done', sessionBoundary: true, agentType: 'brew' },
      { removesProgramStatusRow: true }
    )
    expect(paneRow()).toBeUndefined()
    expect(cleared).toEqual([PANE])
  })

  it('keeps the facet a later report in the same chunk installed when removing the row', () => {
    const facet = { state: 'working' as const, progress: 50, observedAt: 1 }
    programStatus({ state: 'working', agentType: 'brew' })
    server.ingestProgramStatusFacet({ paneKey: PANE, facet })
    programStatus(
      { state: 'done', sessionBoundary: true, agentType: 'brew' },
      { removesProgramStatusRow: true }
    )
    programStatus({ state: 'working', agentType: 'brew' })
    expect(paneRow()?.programStatus).toEqual(facet)
  })

  it("never settles a hook row when a program's records go, even once the hooks fall silent", async () => {
    await openCodeHook('SessionBusy')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(Date.now() + HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS)
    programStatus({ state: 'done', sessionBoundary: true }, { removesProgramStatusRow: true })
    vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
    expect(paneRow()?.state).toBe('working')
  })

  it('drops a pending re-offer once the pane is cleared', async () => {
    await openCodeHook('SessionBusy')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    programStatus({ state: 'done', agentType: 'opencode' })
    server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
    const published: unknown[] = []
    server.setListener((row) => published.push(row))
    published.length = 0
    vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
    expect(published).toEqual([])
  })

  it('applies a child-only change while the root report is unchanged', () => {
    const child = { id: 'worker', state: 'blocked' as const, startedAt: 1 }
    programStatus({ state: 'working', agentType: 'deploy' })
    programStatus({ state: 'working', agentType: 'deploy', subagents: [child] })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.subagents).toEqual([child])
    programStatus({ state: 'working', agentType: 'deploy' })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.subagents).toBeUndefined()
  })

  it("publishes a program's lease renewal to the window", () => {
    const published: string[] = []
    server.setListener((row) => published.push(row.payload.state))
    programStatus({ state: 'working', agentType: 'brew' })
    programStatus({ state: 'working', agentType: 'brew' })
    programStatus({ state: 'working', agentType: 'brew' }, { renewsProgramStatusLease: true })
    expect(published).toEqual(['working', 'working'])
  })

  it('drops the re-offer when a later report agrees with the hooks', async () => {
    await openCodeHook('SessionBusy')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    programStatus({ state: 'done', agentType: 'opencode' })
    programStatus({ state: 'working', agentType: 'opencode' })
    vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
    expect(paneRow()?.state).toBe('working')
  })

  describe('a hook question beside a program still reporting working (#32066)', () => {
    async function piHook(hookEventName: string): Promise<void> {
      const response = await postHookEvent(
        server,
        buildBody({ hook_event_name: hookEventName, prompt: 'fix it' }),
        '/hook/pi'
      )
      expect(response.status).toBe(204)
    }

    // Pi's program status stays `working` through a `ctx.ui.custom()` dialog such as `ask_user`.
    function piWorking(): void {
      server.ingestProgramStatusFacet({
        paneKey: PANE,
        facet: { state: 'working', observedAt: Date.now() }
      })
      programStatus({ state: 'working', agentType: 'pi' })
    }

    it("keeps the question through hook silence and the lease renewal's re-sent working", async () => {
      piWorking()
      await piHook('agent_start')
      await piHook('ui_prompt_start')
      expect(paneRow()?.state).toBe('waiting')
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.advanceTimersByTime(10 * 60 * 1000)
      programStatus({ state: 'working', agentType: 'pi' }, { renewsProgramStatusLease: true })
      vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
      expect(paneRow()?.state).toBe('waiting')
      vi.useRealTimers()
      // Answering hands the row on.
      await piHook('ui_prompt_end')
      expect(paneRow()?.state).toBe('working')
    })

    it('lets a working transition after the question take the row once hooks fall silent', async () => {
      piWorking()
      await piHook('agent_start')
      await piHook('ui_prompt_start')
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.advanceTimersByTime(1_000)
      programStatus({ state: 'done', agentType: 'pi' })
      vi.advanceTimersByTime(1_000)
      programStatus({ state: 'working', agentType: 'pi' })
      expect(paneRow()?.state).toBe('waiting')
      vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS)
      expect(paneRow()?.state).toBe('working')
    })
  })

  describe('a program block beside a hook row', () => {
    const approvePlan = (): void => {
      server.ingestProgramStatusFacet({
        paneKey: PANE,
        facet: {
          state: 'blocked',
          kind: 'permission',
          message: 'Approve plan',
          observedAt: Date.now()
        }
      })
      programStatus({ state: 'waiting', agentType: 'opencode', toolInput: 'Approve plan' })
    }

    it('leaves a turn the hooks settled done, through any hook silence (#31547)', async () => {
      await openCodeHook('SessionBusy')
      server.ingestProgramStatusFacet({
        paneKey: PANE,
        facet: { state: 'working', observedAt: Date.now() }
      })
      programStatus({ state: 'working', agentType: 'opencode' })
      await openCodeHook('SessionIdle')
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      approvePlan()
      vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
      expect(paneRow()?.state).toBe('done')
      expect(resolveProgramStatusPresentation(paneRow()).attention).toBeUndefined()
    })

    it("takes a settled turn's row for an approval in a program turn the hooks missed", async () => {
      await openCodeHook('SessionIdle')
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.advanceTimersByTime(1_000)
      // One output chunk keeps only the latest facet report while preserving lifecycle order.
      server.ingestProgramStatusFacet({
        paneKey: PANE,
        facet: {
          state: 'blocked',
          kind: 'permission',
          message: 'Approve plan',
          observedAt: Date.now()
        }
      })
      programStatus({ state: 'working', agentType: 'opencode' })
      programStatus({ state: 'waiting', agentType: 'opencode', toolInput: 'Approve plan' })
      expect(paneRow()).toMatchObject({ state: 'waiting', toolInput: 'Approve plan' })
    })

    it('counts new work the program reports right after clearing its records', async () => {
      server.ingestProgramStatusFacet({
        paneKey: PANE,
        facet: { state: 'working', observedAt: Date.now() }
      })
      programStatus({ state: 'working', agentType: 'opencode' })
      await openCodeHook('SessionIdle')
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      vi.advanceTimersByTime(1_000)
      server.ingestProgramStatusFacet({
        paneKey: PANE,
        facet: { state: 'blocked', kind: 'permission', observedAt: Date.now() }
      })
      programStatus({ state: 'done', agentType: 'opencode' }, { removesProgramStatusRow: true })
      programStatus({ state: 'working', agentType: 'opencode' })
      programStatus({ state: 'waiting', agentType: 'opencode', toolInput: 'Approve plan' })
      expect(paneRow()).toMatchObject({ state: 'waiting', toolInput: 'Approve plan' })
    })

    it('surfaces an approval the program waits on mid-turn, and takes the row once hooks fall silent', async () => {
      await openCodeHook('SessionBusy')
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      approvePlan()
      expect(resolveProgramStatusPresentation(paneRow()).attention).toEqual({
        kind: 'permission',
        message: 'Approve plan'
      })
      vi.advanceTimersByTime(HOOK_SILENCE_BEFORE_PROGRAM_STATUS_FALLBACK_MS + 1)
      expect(paneRow()).toMatchObject({ state: 'waiting', toolInput: 'Approve plan' })
    })
  })

  describe('hybrid: the program facet rides whichever producer owns the row', () => {
    const facet = {
      state: 'working' as const,
      progress: 42,
      message: 'Running tests',
      observedAt: 1
    }

    it('stitches the facet onto a hook-owned row without touching its state', async () => {
      await openCodeHook('SessionBusy')
      const published: { state?: string; programStatus?: unknown; programStatusOnly?: true }[] = []
      server.setListener((row) =>
        published.push({
          state: row.payload.state,
          programStatus: row.programStatus,
          programStatusOnly: row.programStatusOnly
        })
      )
      published.length = 0
      server.ingestProgramStatusFacet({ paneKey: PANE, facet })
      expect(published).toEqual([
        { state: 'working', programStatus: facet, programStatusOnly: true }
      ])
      expect(paneRow()).toMatchObject({
        state: 'working',
        agentType: 'opencode',
        programStatus: facet
      })

      server.ingestProgramStatusFacet({ paneKey: PANE, facet: { ...facet, observedAt: 2 } })
      expect(published).toHaveLength(1)
    })

    it('tells row-mutation readers the row is unchanged, and skips identity-only rows', async () => {
      const mutations: Parameters<
        Parameters<AgentHookServer['subscribeStatusRowMutations']>[0]
      >[0][] = []
      server.subscribeStatusRowMutations((mutation) => mutations.push(mutation))
      const published: unknown[] = []
      server.setListener((row) => published.push(row))
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        agentType: 'codex',
        providerSession: { key: 'session_id', id: 'resumed-session' },
        launchedAt: Date.now()
      })
      mutations.length = 0
      published.length = 0
      server.ingestProgramStatusFacet({ paneKey: PANE, facet })
      expect(published).toEqual([])
      expect(mutations).toEqual([])

      await openCodeHook('SessionBusy')
      mutations.length = 0
      server.ingestProgramStatusFacet({ paneKey: PANE, facet: { ...facet, state: 'blocked' } })
      expect(mutations).toHaveLength(1)
      expect(mutations[0]?.before).toMatchObject({ paneKey: PANE })
      expect(mutations[0]?.after).toEqual(mutations[0]?.before)
    })

    it('publishes a state change at once and coalesces same-state ticks', async () => {
      await openCodeHook('SessionBusy')
      const progress: (number | undefined)[] = []
      server.setListener((row) => progress.push(row.programStatus?.progress))
      progress.length = 0
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      server.ingestProgramStatusFacet({ paneKey: PANE, facet })
      for (const tick of [43, 44, 45]) {
        server.ingestProgramStatusFacet({ paneKey: PANE, facet: { ...facet, progress: tick } })
      }
      expect(progress).toEqual([42])
      vi.advanceTimersByTime(250)
      expect(progress).toEqual([42, 45])
    })

    it('keeps the facet across later hook events and drops it when the program clears', async () => {
      await openCodeHook('SessionBusy')
      server.ingestProgramStatusFacet({ paneKey: PANE, facet })
      await openCodeHook('SessionIdle')
      expect(paneRow()).toMatchObject({ state: 'done', programStatus: facet })
      server.ingestProgramStatusFacet({ paneKey: PANE, facet: null })
      expect(paneRow()?.programStatus).toBeUndefined()
    })
  })
})
