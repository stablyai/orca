import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { getAgentResumeArgv } from '../../../shared/agent-session-resume'
import { importRecoveryWorkspaceWithHost } from './recovery-import'
import { resumeRecoveryBindingWithHost } from './recovery-resume'
import {
  descriptor,
  emptySession,
  fixture,
  SESSION_ID,
  SOURCE_LEAF,
  SOURCE_TAB
} from './recovery-import.test-fixture'

describe('importRecoveryWorkspaceWithHost', () => {
  it('regenerates ids, remaps paths and writes one dormant record without launching anything', async () => {
    const f = fixture()
    const result = await importRecoveryWorkspaceWithHost(
      f.host,
      {
        descriptor: descriptor(),
        checkoutPath: f.checkout,
        checkpointId: 'cp-1',
        pathMap: [{ from: '/src/home', to: '/dst/home' }]
      },
      f.readCommonDir
    )
    expect(result.disposition).toBe('imported')
    expect(f.ensureAgentSession).not.toHaveBeenCalled()
    const session = f.getSession()
    const [terminal] = session.tabsByWorktree[f.worktreeId]
    expect(terminal.id).not.toBe(SOURCE_TAB)
    expect(terminal.ptyId).toBeNull()
    expect(terminal).not.toHaveProperty('launchAgent')
    expect(terminal.startupCwd).toBe(path.join(f.checkout, 'pkg'))
    expect(result.idMap.tabs[SOURCE_TAB]).toBe(terminal.id)
    expect(result.idMap.leaves[SOURCE_LEAF]).not.toBe(SOURCE_LEAF)
    expect(session.openFilesByWorktree?.[f.worktreeId]?.map((file) => file.filePath)).toEqual([
      path.join(f.checkout, 'a.ts')
    ])
    expect(session.defaultTerminalTabsAppliedByWorktreeId?.[f.worktreeId]).toBe(true)
    const records = Object.values(session.sleepingAgentSessionsByPaneKey ?? {})
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      paneKey: `${terminal.id}:${result.idMap.leaves[SOURCE_LEAF]}`,
      origin: 'recovery',
      restoreOnTabOpenOnly: false,
      launchConfig: { agentArgs: '', agentEnv: {} },
      providerSession: {
        id: SESSION_ID,
        transcriptPath: path.join('/dst/home', '.claude', 't.jsonl')
      },
      recovery: { importKey: result.importKey, sourcePaneKey: `${SOURCE_TAB}:${SOURCE_LEAF}` }
    })
    expect(result.bindings).toEqual([
      expect.objectContaining({
        status: 'dormant',
        binding: expect.objectContaining({ agent: 'claude', id: SESSION_ID }),
        sourceProviderSessionId: SESSION_ID
      })
    ])
  })

  it('resumes each selected id exactly once at its placed pane with host-default args', async () => {
    const f = fixture()
    const result = await importRecoveryWorkspaceWithHost(
      f.host,
      {
        descriptor: descriptor(),
        checkoutPath: f.checkout,
        checkpointId: 'cp-1',
        resume: [SESSION_ID]
      },
      f.readCommonDir
    )
    expect(f.ensureAgentSession).toHaveBeenCalledTimes(1)
    const request = f.ensureAgentSession.mock.calls[0][0]
    expect(request).toMatchObject({
      kind: 'explicit',
      worktree: `id:${f.worktreeId}`,
      agent: 'claude',
      placement: { tabId: result.idMap.tabs[SOURCE_TAB], leafId: result.idMap.leaves[SOURCE_LEAF] }
    })
    expect(request).not.toHaveProperty('agentArgs')
    expect(getAgentResumeArgv('claude', { key: 'session_id', id: SESSION_ID })).toEqual([
      'claude',
      '--resume',
      SESSION_ID
    ])
    expect(result.bindings[0]).toMatchObject({ status: 'resumed', terminalHandle: 'term-1' })
    expect(f.getSession().sleepingAgentSessionsByPaneKey).toEqual({})
  })

  it('replays the same import without touching layout or a live pane', async () => {
    const f = fixture()
    const request = { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp-1' }
    await importRecoveryWorkspaceWithHost(f.host, request, f.readCommonDir)
    const before = f.getSession()
    const replay = await importRecoveryWorkspaceWithHost(
      f.host,
      { ...request, resume: [SESSION_ID] },
      f.readCommonDir
    )
    expect(replay.disposition).toBe('replayed')
    expect(f.getSession().tabsByWorktree).toEqual(before.tabsByWorktree)
    expect(f.ensureAgentSession).toHaveBeenCalledTimes(1)

    const live = fixture({ live: true })
    await importRecoveryWorkspaceWithHost(
      live.host,
      { ...request, checkoutPath: live.checkout },
      live.readCommonDir
    )
    const liveReplay = await importRecoveryWorkspaceWithHost(
      live.host,
      { ...request, checkoutPath: live.checkout, resume: [SESSION_ID] },
      live.readCommonDir
    )
    expect(liveReplay.bindings[0]).toMatchObject({
      status: 'refused',
      reason: 'recovery_session_live_locally'
    })
    expect(live.ensureAgentSession).not.toHaveBeenCalled()
    expect(Object.values(live.getSession().sleepingAgentSessionsByPaneKey ?? {})).toHaveLength(1)
  })

  it('never re-adds a dormant twin or launches twice while a resume of that binding is launching', async () => {
    let finishLaunch = (): void => {}
    const f = fixture({
      ensure: () =>
        new Promise((resolve) => {
          finishLaunch = () =>
            resolve({
              terminal: { handle: 'term-1', worktreeId: 'wt', title: null },
              disposition: 'created'
            })
        })
    })
    const request = { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp-1' }
    await importRecoveryWorkspaceWithHost(f.host, request, f.readCommonDir)
    const resuming = resumeRecoveryBindingWithHost(f.host, {
      worktree: `id:${f.worktreeId}`,
      binding: SESSION_ID
    })
    await vi.waitFor(() => expect(f.ensureAgentSession).toHaveBeenCalledTimes(1))
    const replay = await importRecoveryWorkspaceWithHost(
      f.host,
      { ...request, resume: [SESSION_ID] },
      f.readCommonDir
    )
    expect(replay.bindings[0]).toMatchObject({
      status: 'refused',
      reason: 'recovery_session_live_locally'
    })
    expect(Object.values(f.getSession().sleepingAgentSessionsByPaneKey ?? {})).toHaveLength(1)
    expect(f.ensureAgentSession).toHaveBeenCalledTimes(1)
    finishLaunch()
    await expect(resuming).resolves.toMatchObject({ terminalHandle: 'term-1' })
    expect(f.getSession().sleepingAgentSessionsByPaneKey).toEqual({})
    expect(f.host.resumeHolds.isHeld({ agent: 'claude', key: 'session_id', id: SESSION_ID })).toBe(
      false
    )
  })

  it('refuses a destination that already has tabs', async () => {
    const f = fixture()
    f.host.getLocalSession = () => ({
      ...emptySession(),
      openFilesByWorktree: {
        [f.worktreeId]: [
          { filePath: 'x', relativePath: 'x', worktreeId: f.worktreeId, language: 'ts' }
        ]
      }
    })
    await expect(
      importRecoveryWorkspaceWithHost(
        f.host,
        { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp' },
        f.readCommonDir
      )
    ).rejects.toThrow('recovery_destination_not_empty')
  })

  it('re-keys forked sessions through sessionIdMap and resumes by local id', async () => {
    const f = fixture()
    const result = await importRecoveryWorkspaceWithHost(
      f.host,
      {
        descriptor: descriptor(),
        checkoutPath: f.checkout,
        checkpointId: 'cp-1',
        sessionIdMap: [{ from: SESSION_ID, to: 'local-fork' }],
        dryRun: true
      },
      f.readCommonDir
    )
    expect(result.bindings).toEqual([
      expect.objectContaining({
        binding: expect.objectContaining({ id: 'local-fork' }),
        sourceProviderSessionId: SESSION_ID
      })
    ])
    await expect(
      importRecoveryWorkspaceWithHost(
        f.host,
        {
          descriptor: descriptor(),
          checkoutPath: f.checkout,
          checkpointId: 'cp-1',
          sessionIdMap: [{ from: SESSION_ID, to: 'local-fork' }],
          resume: [SESSION_ID],
          dryRun: true
        },
        f.readCommonDir
      )
    ).rejects.toThrow('recovery_binding_not_found')
  })
})
