import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { GOOD_PANE, PANE } from './server.test-fixtures'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentProcessPresence } from '../../shared/agent-process-presence'
import { projectPluginAgentStatusChangedPayload } from '../plugins/plugin-agent-status-event'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn(async () => 'live')
}))

const owner = {
  agent: 'claude',
  process: { pid: 4001, platform: 'linux', startTime: 'boot:123' }
} satisfies AgentProcessPresence
const replacement = {
  agent: 'claude',
  process: { pid: 5005, platform: 'linux', startTime: 'boot:999' }
} satisfies AgentProcessPresence

class LifecycleServer extends AgentHookServer {
  serializedEntries(): Record<string, unknown> {
    return JSON.parse(this.serializeStatusFile()).entries
  }

  publish(overrides: Partial<AgentHookEventPayload> = {}): void {
    this.applyNormalizedStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'folder-1',
      connectionId: null,
      source: 'claude',
      hookEventName: 'UserPromptSubmit',
      agentPresence: owner,
      payload: { agentType: 'claude', state: 'working', prompt: 'task' },
      ...overrides
    })
  }

  /** What the HTTP ingest does for every admitted hook. */
  hook(overrides: Partial<AgentHookEventPayload>): void {
    const event: AgentHookEventPayload = {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'folder-1',
      connectionId: null,
      source: 'claude',
      hookEventName: 'SessionStart',
      payload: { agentType: 'claude', state: 'working', prompt: 'new session' },
      ...overrides
    }
    const enriched = this.applyNormalizedStatus(event)
    if (enriched) {
      this.checkAgentPresenceAfterHook(event, enriched)
    }
  }
}

const dirs: string[] = []
const servers: LifecycleServer[] = []
function createServer(): LifecycleServer {
  const server = new LifecycleServer()
  servers.push(server)
  return server
}
afterEach(() => {
  vi.mocked(probeAgentProcessPresence).mockReset().mockResolvedValue('live')
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function restartWithOwnerRow(): Promise<LifecycleServer> {
  const dir = mkdtempSync(join(tmpdir(), 'owner-lifecycle-'))
  dirs.push(dir)
  const first = createServer()
  await first.start({ env: 'production', userDataPath: dir })
  first.publish()
  first.flushStatusPersistSync()
  first.stop()
  const second = createServer()
  await second.start({ env: 'production', userDataPath: dir })
  return second
}

describe('host owner lifecycle', () => {
  it('releases the owner with its local terminal in every projection, never as an exit', () => {
    const server = createServer()
    server.publish()
    const live = vi.fn()
    const released = vi.fn()
    server.subscribeEnrichedStatus(live)
    server.setAgentPresenceReleaseListener(released)
    server.clearPaneState(PANE, 'released')
    // Why: sleep and hibernate tear the terminal down; that must not read as the agent finishing,
    // neither live nor in a later snapshot, replay or restart.
    expect(released).toHaveBeenCalledWith({ paneKey: PANE, process: owner.process })
    expect(live).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.serializedEntries()).toEqual({})
  })

  it('lets the restored-pane reaper end an owner whose terminal died while Orca was down', async () => {
    const server = await restartWithOwnerRow()
    await flush()
    const reaped = await server.reapRestoredClaudeSubagentsWithoutLiveAgent(
      () => true,
      async () => false,
      () => true
    )
    expect(reaped).toBe(1)
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.hasVerifiableAgentProcess(PANE)).toBe(false)
  })

  it('rechecks every restored owner once at startup', async () => {
    vi.mocked(probeAgentProcessPresence).mockResolvedValue('exited')
    const server = await restartWithOwnerRow()
    await flush()
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ agentPresence: { ...owner, ended: true } })
    ])
  })

  it('publishes a release when retirement drops an identified owner', () => {
    const server = createServer()
    const released = vi.fn()
    server.setAgentPresenceReleaseListener(released)
    server.publish()
    server.retirePaneAuthority(PANE)
    expect(released).toHaveBeenCalledWith({ paneKey: PANE, process: owner.process })
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('does not publish a release while the same owner is carried forward', () => {
    const server = createServer()
    const released = vi.fn()
    server.setAgentPresenceReleaseListener(released)
    server.publish()
    server.dropStatusEntry(PANE)
    server.clearPaneState(PANE, 'unverified')
    expect(released).not.toHaveBeenCalled()
  })

  it.each(['silent death', 'dismissal', 'unverified cleanup'])(
    'hands the pane to the process whose hook proved the old owner dead (%s)',
    async (howOwnerWasLeft) => {
      const server = createServer()
      server.publish()
      if (howOwnerWasLeft === 'dismissal') {
        server.dropStatusEntry(PANE)
      } else if (howOwnerWasLeft === 'unverified cleanup') {
        server.clearPaneState(PANE, 'unverified')
      }
      const live = vi.fn()
      server.subscribeEnrichedStatus(live)
      vi.mocked(probeAgentProcessPresence).mockResolvedValue('exited')
      server.hook({ agentPresence: replacement })
      await flush()
      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ state: 'working', agentPresence: replacement })
      ])
      expect(server.getStatusSnapshot()[0]?.providerSessionOnly).toBeUndefined()
      expect(live.mock.calls.some(([row]) => row.agentPresence?.ended)).toBe(false)
    }
  )

  it('keeps a real exit when cleanup rewrites the row during the probe', async () => {
    const server = createServer()
    server.publish()
    let resolveProbe!: (verdict: 'exited') => void
    vi.mocked(probeAgentProcessPresence).mockImplementationOnce(
      () => new Promise((resolve) => (resolveProbe = resolve))
    )
    const pending = server.checkAgentPresence(PANE, owner.process)
    server.clearPaneState(PANE, 'unverified')
    resolveProbe('exited')
    await expect(pending).resolves.toBe('exited')
    expect(server.getStatusSnapshot()[0]?.agentPresence).toEqual({ ...owner, ended: true })
  })

  it('adopts the owner a relay stamped instead of the stale desktop record', () => {
    const server = createServer()
    server.publish({ connectionId: 'ssh-a' })
    server.clearPaneState(PANE, 'unverified')
    server.publish({
      connectionId: 'ssh-a',
      hookEventName: 'SessionStart',
      agentPresence: replacement
    })
    expect(server.getStatusSnapshot()[0]?.agentPresence).toEqual(replacement)
    server.publish({
      connectionId: 'ssh-a',
      hookEventName: 'SessionEnd',
      providerSessionOnly: true,
      agentPresence: { ...replacement, ended: true }
    })
    expect(server.getStatusSnapshot()[0]?.agentPresence).toEqual({ ...replacement, ended: true })
    expect(server.getStatusChangeSnapshot()).toEqual([])
  })

  it('drops a removed workspace like closing its tabs', () => {
    const server = createServer()
    server.publish()
    server.clearPaneState(PANE, 'unverified')
    server.publish({
      paneKey: GOOD_PANE,
      tabId: 'tab-good',
      worktreeId: 'folder-2',
      agentPresence: replacement
    })
    server.dropStatusEntriesForWorktree('folder-1')
    expect(server.getStatusSnapshot().map((row) => row.paneKey)).toEqual([GOOD_PANE])
    expect(Object.keys(server.serializedEntries())).toEqual([GOOD_PANE])
  })

  it('drops every workspace of a removed repo', () => {
    const server = createServer()
    server.publish({ worktreeId: 'repo-a::/a' })
    server.publish({ paneKey: GOOD_PANE, tabId: 'tab-good', worktreeId: 'repo-b::/b' })
    server.dropStatusEntriesForRepo('repo-a')
    expect(server.getStatusSnapshot().map((row) => row.paneKey)).toEqual([GOOD_PANE])
  })

  it('never lets a legacy shell-foreground signal end an identified owner', () => {
    const server = createServer()
    server.publish()
    expect(
      server.reconcileEndedProcessForPaneKeys([PANE], { kind: 'legacy-shell-foreground' })
    ).toBe(0)
    expect(server.getStatusSnapshot()[0]?.agentPresence).toEqual(owner)
    expect(server.hasVerifiableAgentProcess(PANE)).toBe(true)
  })

  it('keeps a retained owner row out of the plugin status tap', () => {
    const server = createServer()
    server.publish()
    const projected = vi.fn()
    server.subscribeEnrichedStatus((row) => projected(projectPluginAgentStatusChangedPayload(row)))
    server.reconcileEndedProcessForPaneKeys([PANE], {
      kind: 'owner-exited',
      presence: { ...owner, ended: true }
    })
    expect(projected).toHaveBeenCalledTimes(1)
    expect(projected).toHaveBeenLastCalledWith(null)
  })

  it('leaves an owner no host can check (WSL) to the legacy exit rules', async () => {
    const server = createServer()
    server.publish({ connectionId: 'wsl:Ubuntu' })
    expect(server.hasVerifiableAgentProcess(PANE)).toBe(false)
    await expect(server.checkAgentPresence(PANE)).resolves.toBeNull()
    // Published without its process, so renderers keep the pre-presence rules for this pane.
    expect(server.getStatusSnapshot()[0]?.agentPresence).toEqual({ agent: 'claude' })
    expect(
      server.reconcileEndedProcessForPaneKeys([PANE], { kind: 'legacy-shell-foreground' })
    ).toBe(1)
    expect(server.getStatusChangeSnapshot()).toEqual([])
  })
})
