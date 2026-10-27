import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import {
  bindOpenCodeSession,
  lookupOpenCodePaneLaunchToken,
  lookupOpenCodeSessionPane
} from '../../shared/agent-hook-listener/opencode-session-registry'
import { makePaneKey } from '../../shared/stable-pane-id'

const PANE_A = makePaneKey('tab-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
const PANE_B = makePaneKey('tab-b', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
const PANE_C = makePaneKey('tab-c', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')

class IsolatedHookServer extends AgentHookServer {
  isolateBinder(dbPath: string) {
    this._setOpenCodeBinderDepsForTests({
      dbPath: () => dbPath,
      listPanes: () => [],
      sweep: async () => []
    })
  }
}

describe('legacy TUI identity admitted by the canonical hook server', () => {
  let dir: string
  let server: IsolatedHookServer

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-opencode-tui-host-'))
    server = new IsolatedHookServer()
    server.isolateBinder(join(dir, 'no-user-database'))
    await server.start({ env: 'test', userDataPath: dir })
  })
  afterEach(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  async function post(
    paneKey: string,
    sessionID: string,
    hookEventName = 'SessionBusy',
    extra: Record<string, unknown> = {}
  ) {
    const env = server.buildPtyEnv()
    const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        paneKey,
        tabId: paneKey.split(':')[0],
        worktreeId: 'folder::same-folder',
        env: 'test',
        launchToken: 'old-generation',
        opencodeTui: 1,
        payload: { hook_event_name: hookEventName, sessionID },
        ...extra
      })
    })
    expect(response.ok).toBe(true)
  }
  const binding = (id: string) => lookupOpenCodeSessionPane(server._getStateForTests(), id)

  it('publishes two same-folder sessions separately and prevents a shared post from ending either', async () => {
    await post(PANE_A, 'ses_a')
    await post(PANE_B, 'ses_b')
    await post(PANE_A, 'ses_b', 'SessionIdle', { opencodeTui: undefined, opencodeSharedServer: 1 })
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE_A, state: 'working' }),
      expect.objectContaining({ paneKey: PANE_B, state: 'working' })
    ])
    await post(PANE_B, 'ses_b', 'SessionIdle')
    expect(server.getStatusSnapshotForPane(PANE_A)[0]?.state).toBe('working')
    expect(server.getStatusSnapshotForPane(PANE_B)[0]?.state).toBe('done')
    expect(binding('ses_a')?.paneKey).toBe(PANE_A)
    expect(binding('ses_b')?.paneKey).toBe(PANE_B)
  })

  it('keeps the known creator when a different live pane views its session', async () => {
    await post(PANE_B, 'ses_b')
    await post(PANE_A, 'ses_b')
    expect(binding('ses_b')?.paneKey).toBe(PANE_B)
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: PANE_B, state: 'working' })
    ])
  })

  describe.each(['retired', 'closed-tab', 'replaced-token'] as const)(
    '%s physical viewer',
    (fence) => {
      it.each(['SessionIdle', 'PermissionRequest', 'MessagePart'] as const)(
        'cannot overwrite its live creator with a late %s',
        async (hookEventName) => {
          await post(PANE_B, 'ses_b', 'SessionBusy', { launchToken: 'creator-live' })
          await post(PANE_C, 'ses_c', 'SessionBusy', { launchToken: 'viewer-old' })
          if (fence === 'closed-tab') {
            server.dropStatusEntriesByTabPrefix('tab-c')
          } else {
            server.retirePaneAuthority(PANE_C)
            if (fence === 'replaced-token') {
              await post(PANE_C, 'ses_new', 'SessionStart', { launchToken: 'viewer-new' })
            }
          }
          const state = server._getStateForTests()
          const creator = state.lastStatusByPaneKey.get(PANE_B)
          const owner = { ...binding('ses_b') }
          const tokens = [...state.lastLaunchTokenByPaneKey]
          await post(PANE_C, 'ses_b', hookEventName, {
            launchToken: 'viewer-old',
            payload: {
              hook_event_name: hookEventName,
              sessionID: 'ses_b',
              role: 'assistant',
              text: 'late viewer text',
              permission: 'bash',
              requestID: 'late-request'
            }
          })
          expect(state.lastStatusByPaneKey.get(PANE_B)).toBe(creator)
          expect(binding('ses_b')).toEqual(owner)
          expect([...state.lastLaunchTokenByPaneKey]).toEqual(tokens)
          expect(server.getStatusSnapshotForPane(PANE_B)[0]?.state).toBe('working')
        }
      )
    }
  )

  it('does not let a rejected same-pane token replace the creator token used by a live viewer', async () => {
    server.retirePaneAuthority(PANE_B)
    await post(PANE_B, 'ses_b', 'SessionStart', { launchToken: 'creator-live' })
    await post(PANE_B, 'ses_b', 'SessionBusy', { launchToken: 'creator-live' })
    await post(PANE_B, 'ses_b', 'SessionIdle', { launchToken: 'creator-old' })
    expect(lookupOpenCodePaneLaunchToken(server._getStateForTests(), PANE_B)).toBe('creator-live')
    await post(PANE_C, 'ses_b', 'SessionIdle', { launchToken: 'viewer-live' })
    expect(server.getStatusSnapshotForPane(PANE_B)[0]?.state).toBe('done')
    expect(binding('ses_b')?.paneKey).toBe(PANE_B)
  })

  it('admits a replacement viewer with its own current token and keeps the creator', async () => {
    await post(PANE_B, 'ses_b', 'SessionBusy', { launchToken: 'creator-live' })
    await post(PANE_C, 'ses_c', 'SessionBusy', { launchToken: 'viewer-old' })
    server.retirePaneAuthority(PANE_C)
    await post(PANE_C, 'ses_new', 'SessionStart', { launchToken: 'viewer-new' })
    await post(PANE_C, 'ses_b', 'SessionIdle', { launchToken: 'viewer-new' })
    expect(server.getStatusSnapshotForPane(PANE_B)[0]?.state).toBe('done')
    expect(binding('ses_b')?.paneKey).toBe(PANE_B)
    await post(PANE_C, 'ses_new', 'SessionBusy', { launchToken: 'viewer-new' })
    expect(server.getStatusSnapshotForPane(PANE_C)[0]?.state).toBe('working')
  })

  it('allows a fresh viewer user prompt to restart its physical pane and fence later hooks', async () => {
    await post(PANE_B, 'ses_b', 'SessionBusy', { launchToken: 'creator-live' })
    await post(PANE_C, 'ses_c', 'SessionBusy', { launchToken: 'viewer-old' })
    server.retirePaneAuthority(PANE_C)
    await post(PANE_C, 'ses_b', 'MessagePart', {
      launchToken: 'viewer-new',
      payload: {
        hook_event_name: 'MessagePart',
        sessionID: 'ses_b',
        role: 'user',
        text: 'continue from this live viewer'
      }
    })
    const creator = server._getStateForTests().lastStatusByPaneKey.get(PANE_B)
    expect(creator?.payload.prompt).toBe('continue from this live viewer')
    await post(PANE_C, 'ses_b', 'SessionIdle', { launchToken: 'viewer-old' })
    expect(server._getStateForTests().lastStatusByPaneKey.get(PANE_B)).toBe(creator)
    await post(PANE_C, 'ses_b', 'SessionIdle', { launchToken: 'viewer-new' })
    expect(server.getStatusSnapshotForPane(PANE_B)[0]?.state).toBe('done')
    expect(binding('ses_b')?.paneKey).toBe(PANE_B)
  })

  it('applies the physical launch fence through an existing legacy pane alias', async () => {
    await post(PANE_B, 'ses_b', 'SessionBusy', { launchToken: 'creator-live' })
    await post(PANE_C, 'ses_c', 'SessionBusy', { launchToken: 'viewer-old' })
    server.retirePaneAuthority(PANE_C)
    await post(PANE_C, 'ses_new', 'SessionStart', { launchToken: 'viewer-new' })
    server.registerPaneKeyAlias('tab-c:0', PANE_C, 'pty-c')
    const creator = server._getStateForTests().lastStatusByPaneKey.get(PANE_B)
    await post('tab-c:0', 'ses_b', 'SessionIdle', { launchToken: 'viewer-old' })
    expect(server._getStateForTests().lastStatusByPaneKey.get(PANE_B)).toBe(creator)
    await post('tab-c:0', 'ses_b', 'SessionIdle', { launchToken: 'viewer-new' })
    expect(server.getStatusSnapshotForPane(PANE_B)[0]?.state).toBe('done')
  })

  it('preserves attribution from an old frozen server stamp even when its physical tab closed', async () => {
    await post(PANE_B, 'ses_b', 'SessionBusy', { opencodeTui: undefined })
    bindOpenCodeSession(server._getStateForTests(), 'ses_b', {
      paneKey: PANE_B,
      boundAt: 1,
      basis: 'argv'
    })
    server.dropStatusEntriesByTabPrefix('tab-c')
    await post(PANE_C, 'ses_b', 'SessionIdle', { opencodeTui: undefined })
    expect(server.getStatusSnapshotForPane(PANE_B)[0]?.state).toBe('done')
  })

  it('retains the creator destination fence after admitting a live viewer', async () => {
    await post(PANE_B, 'ses_b')
    server.dropStatusEntriesByTabPrefix('tab-b')
    bindOpenCodeSession(server._getStateForTests(), 'ses_b', {
      paneKey: PANE_B,
      boundAt: 1,
      basis: 'argv'
    })
    await post(PANE_C, 'ses_b', 'SessionIdle')
    expect(server.getStatusSnapshot()).toEqual([])
    expect(binding('ses_b')?.basis).toBe('argv')
  })

  it('does not resurrect retired identity from a late old-generation hook', async () => {
    await post(PANE_A, 'ses_old')
    server.retirePaneAuthority(PANE_A)
    expect(binding('ses_old')).toBeUndefined()
    await post(PANE_A, 'ses_old', 'SessionIdle')
    expect(binding('ses_old')).toBeUndefined()
    expect(server.getStatusSnapshot()).toEqual([])
    await post(PANE_A, 'ses_new', 'SessionStart', { launchToken: 'new-generation' })
    expect(binding('ses_new')?.paneKey).toBe(PANE_A)
    expect(binding('ses_old')).toBeUndefined()
  })

  it('rejects another execution host token before learning its identity', async () => {
    const other = new IsolatedHookServer()
    other.isolateBinder(join(dir, 'other-no-user-database'))
    await other.start({ env: 'other-host', userDataPath: join(dir, 'other-host') })
    try {
      const { ORCA_AGENT_HOOK_PORT } = server.buildPtyEnv()
      const { ORCA_AGENT_HOOK_TOKEN } = other.buildPtyEnv()
      const response = await fetch(`http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: PANE_A,
          env: 'other-host',
          opencodeTui: 1,
          payload: { hook_event_name: 'SessionBusy', sessionID: 'ses_other_host' }
        })
      })
      expect(response.status).toBe(403)
      expect(binding('ses_other_host')).toBeUndefined()
      expect(server.getStatusSnapshot()).toEqual([])
    } finally {
      other.stop()
    }
  })
})
