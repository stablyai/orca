import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const AGENT_PANE = makePaneKey('tab-agent', '11111111-1111-4111-8111-111111111111')
const AGENT_WORKTREE = 'repo-agent::/Users/dev/workspace/agent'

/**
 * Hook body reproducing the shared-daemon leak: a session running in one project posts
 * the pane identity it inherited from the pane that first spawned the agent daemon.
 */
function buildBody(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    paneKey: AGENT_PANE,
    tabId: 'tab-agent',
    worktreeId: AGENT_WORKTREE,
    env: 'production',
    payload
  }
}

/** Relay a hook for the agent pane from a session running somewhere else entirely. */
function ingestForeign(server: AgentHookServer, prompt: string): void {
  server.ingestRemote(
    {
      paneKey: AGENT_PANE,
      tabId: 'tab-agent',
      worktreeId: AGENT_WORKTREE,
      // Why: the relay forwards cwd beside the payload — normalization strips it from the payload itself.
      sourceCwd: '/srv/other-project',
      payload: { state: 'working', prompt }
    },
    'conn-1'
  )
}

function unattributedCallCount(): number {
  return trackMock.mock.calls.filter(([name]) => name === 'agent_hook_unattributed').length
}

beforeEach(() => {
  trackMock.mockReset()
})

describe('AgentHookServer cwd attribution guard', () => {
  it('drops an HTTP hook whose session cwd belongs to another workspace', async () => {
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await expect(
        postHook({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'own session',
          cwd: '/Users/dev/workspace/agent'
        })
      ).resolves.toMatchObject({ status: 204 })
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: AGENT_PANE, prompt: 'own session' })
      ])

      await expect(
        postHook({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'foreign session',
          cwd: '/Users/dev/projects/api'
        })
      ).resolves.toMatchObject({ status: 204 })

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: AGENT_PANE, prompt: 'own session' })
      ])
      expect(trackMock).toHaveBeenCalledWith('agent_hook_unattributed', {
        reason: 'cwd_worktree_mismatch'
      })
    } finally {
      server.stop()
    }
  })

  it('drops a relayed hook whose session cwd belongs to another workspace', () => {
    const server = new AgentHookServer()
    ingestForeign(server, 'foreign session')

    expect(server.getStatusSnapshot()).toEqual([])
    expect(trackMock).toHaveBeenCalledWith('agent_hook_unattributed', {
      reason: 'cwd_worktree_mismatch'
    })
  })

  it('reports a mis-attributing daemon once per runtime', () => {
    // Why: the telemetry per-session ceiling never refills, so a daemon that mis-attributes
    // every hook it hosts would otherwise silence every other event in the session.
    const server = new AgentHookServer()
    for (const prompt of ['first', 'second', 'third']) {
      ingestForeign(server, prompt)
    }

    expect(server.getStatusSnapshot()).toEqual([])
    expect(unattributedCallCount()).toBe(1)
  })

  it('reports again after a restart, so one runtime does not silence the next', () => {
    const server = new AgentHookServer()
    ingestForeign(server, 'before restart')
    server.stop()
    ingestForeign(server, 'after restart')

    expect(unattributedCallCount()).toBe(2)
  })

  it('refuses a foreign hook before it can seed the pane subagent roster', async () => {
    // Why: normalization mutates per-pane listener state; if the drop happens after it, a
    // foreign SubagentStart still plants a roster row that the pane's own next event re-emits.
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const postHook = (payload: Record<string, unknown>): Promise<Response> =>
        fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
          },
          body: JSON.stringify(buildBody(payload))
        })

      await expect(
        postHook({
          hook_event_name: 'SubagentStart',
          agent_id: 'sa-foreign',
          cwd: '/Users/dev/projects/api'
        })
      ).resolves.toMatchObject({ status: 204 })
      await expect(
        postHook({
          hook_event_name: 'UserPromptSubmit',
          prompt: 'own session',
          cwd: '/Users/dev/workspace/agent'
        })
      ).resolves.toMatchObject({ status: 204 })

      const rows = server.getStatusSnapshot()
      expect(rows).toEqual([
        expect.objectContaining({ paneKey: AGENT_PANE, prompt: 'own session' })
      ])
      expect(rows[0]?.subagents ?? []).toEqual([])
    } finally {
      server.stop()
    }
  })

  it('keeps a status whose cwd is only a symlink alias of the worktree path', async () => {
    // Why: Orca stores the workspace path as picked while agents report physical getcwd
    // (macOS /tmp is /private/tmp); one directory spelled two ways is not a foreign session.
    const base = mkdtempSync(join(tmpdir(), 'orca-hook-cwd-'))
    const real = join(base, 'real-workspace')
    mkdirSync(real, { recursive: true })
    const link = join(base, 'linked-workspace')
    try {
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      rmSync(base, { recursive: true, force: true })
      return // Restricted hosts that cannot create links have nothing to verify here.
    }
    const server = new AgentHookServer()
    await server.start({ env: 'production' })
    try {
      const env = server.buildPtyEnv()
      const res = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: AGENT_PANE,
          tabId: 'tab-agent',
          worktreeId: `repo-agent::${link}`,
          env: 'production',
          payload: {
            hook_event_name: 'UserPromptSubmit',
            prompt: 'aliased session',
            cwd: realpathSync(real)
          }
        })
      })
      expect(res.status).toBe(204)
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: AGENT_PANE, prompt: 'aliased session' })
      ])
      expect(trackMock).not.toHaveBeenCalledWith('agent_hook_unattributed', {
        reason: 'cwd_worktree_mismatch'
      })
    } finally {
      server.stop()
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('keeps hooks that report no cwd, so sources without one stay attributed', () => {
    const server = new AgentHookServer()
    server.ingestRemote(
      {
        paneKey: AGENT_PANE,
        tabId: 'tab-agent',
        worktreeId: AGENT_WORKTREE,
        payload: { state: 'working', prompt: 'no cwd reported' }
      },
      'conn-1'
    )

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: AGENT_PANE, prompt: 'no cwd reported' })
    ])
    expect(trackMock).not.toHaveBeenCalledWith('agent_hook_unattributed', {
      reason: 'cwd_worktree_mismatch'
    })
  })
})
