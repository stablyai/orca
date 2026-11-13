import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from '../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { publishedOrcaSessionId } from '../../../identity/pane-agent-identities'
import { installHookStatusSessionTabsRepublish } from '../../../runtime/hook-status-session-tabs-republish'
import { InProcessAgentIdentityClient } from '../../../identity/agent-identity-client.test-fixtures'
import type { AgentIdentityClient } from '../../../identity/agent-identity-worker-client'
import { AgentHookServer } from '../../agent-hook-server'
import { LastStatusStore } from '../../last-status-store'
import type { LastStatusFile } from '../../server-types'
import { buildBody } from '../server.test-fixtures'
import { TMUX_TEST_ROOT } from '../../../../../shared/tmux-status.test-fixture'
import type { AgentHookEventPayload } from '../../../../../shared/agent-hook-listener/listener-event'

const WSL = 'wsl:Ubuntu'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function paneKey(index: number): string {
  return makePaneKey(`tab-${index}`, `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
}

function tmuxPaneKey(index: number): string {
  return makePaneKey(`tmux-${index}`, `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`)
}

function hook(index: number, sessionId: string, hookEventName = 'UserPromptSubmit') {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(
      { hook_event_name: hookEventName, session_id: sessionId, prompt: `task ${index}` },
      { paneKey: paneKey(index), tabId: `tab-${index}` }
    ),
    'production'
  )
  if (!event) {
    throw new Error('hook was rejected')
  }
  return event
}

// Fixed, increasing evidence clocks: a later publication is newer, with no wall clock involved.
let tmuxClock = 1_700_000_000_000

/** The identity worker's real SQL handler behind an async boundary, counting its requests. */
class IdentityTestServer extends AgentHookServer {
  readonly identityClient = new InProcessAgentIdentityClient()

  protected override createAgentIdentityClient(): AgentIdentityClient {
    return this.identityClient
  }

  /** The owner's own status path change, as start and stop make it. */
  moveStatusFile(path: string): void {
    this.setStatusFilePath(path)
  }

  endIdentityAuthority(): void {
    this.agentIdentities.close()
  }

  /** The tmux owner's own publication path for one selected terminal agent. */
  publishTmuxTerminal(index: number, sessionId: string): void {
    const paneKey = tmuxPaneKey(index)
    const event: AgentHookEventPayload = {
      paneKey,
      tabId: `tmux-${index}`,
      worktreeId: 'workspace',
      connectionId: null,
      source: 'opencode',
      providerSession: { key: 'session_id', id: sessionId },
      payload: { state: 'working', prompt: `tmux ${index}`, agentType: 'opencode' }
    }
    const now = ++tmuxClock
    this.publishTmuxSelectedStatus(
      event,
      now,
      { ...TMUX_TEST_ROOT.scope, kind: 'pty', paneKey },
      now
    )
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-identity-scaling-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function started<T extends AgentHookServer>(server: T, dir = tempDir()): Promise<T> {
  cleanups.unshift(() => server.stop())
  await server.start({ env: 'production', userDataPath: dir })
  // A real status subscriber, so internal notifications are built on every mutation.
  cleanups.unshift(server.subscribeStatusChanges(() => {}))
  return server
}

/** Lets the identity worker's queued answers arrive and re-stamp their rows. */
const answered = () => new Promise((resolve) => setImmediate(resolve))

async function serverWith(panes: number, tmuxPanes = 0): Promise<IdentityTestServer> {
  const server = await started(new IdentityTestServer())
  for (let index = 0; index < panes; index++) {
    server.ingestRemote(hook(index, `session-${index}`), WSL)
  }
  for (let index = 0; index < tmuxPanes; index++) {
    server.publishTmuxTerminal(index, `tmux-session-${index}`)
  }
  await answered()
  return server
}

/** Restarts from the saved status document without a disk round trip. */
class RestartingServer extends IdentityTestServer {
  constructor(private readonly saved?: LastStatusFile) {
    super()
  }

  savedStatus(): LastStatusFile {
    return this.buildStatusFile()
  }

  protected override getStatusStore(): LastStatusStore | null {
    const saved = this.saved
    const path = this.lastStatusPath
    if (!saved || !path) {
      return super.getStatusStore()
    }
    return new (class extends LastStatusStore {
      override read() {
        return { document: saved, source: 'rows' as const }
      }
    })(path)
  }
}

it('claims a running place only for an agent this runtime has observed', async () => {
  const dir = tempDir()
  const first = await started(new RestartingServer(), dir)
  first.ingestRemote(hook(0, 'session-0', 'Stop'), WSL)
  first.ingestRemote(hook(1, 'session-1', 'Stop'), WSL)
  await answered()
  const id = first.getStatusSnapshot()[0]?.orcaSessionId
  const dormant = first.getStatusSnapshot()[1]?.orcaSessionId
  first.dropStatusEntry(paneKey(1), { preserveResumeIdentity: false })
  first.setTerminalPaneLifecycle({
    ownsProcess: (key, pty) => key === paneKey(0) && pty === 'sleeping-pty',
    isStopping: () => true,
    isReversibleStop: (pty) => pty === 'sleeping-pty',
    isPlaced: () => true
  })
  expect(first.settleTerminalPaneSleep(paneKey(0), 'sleeping-pty')).toBe(true)
  expect(first.getStatusSnapshot()[0]).toMatchObject({ state: 'done', orcaSessionId: id })
  expect(await first.terminalAgentPlaces(id!)).toEqual([])

  const saved = first.savedStatus()
  first.stop()

  // A saved Done status is history: the agent may have exited while Orca was closed.
  const restarted = await started(new RestartingServer(saved), dir)
  await answered()
  expect(restarted.getStatusSnapshot()[0]).toMatchObject({ state: 'done', orcaSessionId: id })
  expect(await restarted.terminalAgentPlaces(id!)).toEqual([])
  // No row carries it now: the refusal waits for the store before calling it a terminal agent.
  expect(await restarted.terminalAgentPlaces(dormant!)).toEqual([])
  expect(restarted.identityClient.hasRequests).toBe(1)
  expect(await restarted.terminalAgentPlaces('claude_never_minted_here')).toBeNull()
  restarted.ingestRemote(hook(0, 'session-0'), WSL)
  expect(await restarted.terminalAgentPlaces(id!)).toEqual([
    { paneKey: paneKey(0), worktreeId: 'wt-1' }
  ])
})

it('publishes a lost first answer as pending, and the click recovers the committed id', async () => {
  const server = await started(new IdentityTestServer())
  // The worker commits the link but its reply is lost, as when it crashes mid-answer.
  server.identityClient.failAfterCommit = 1
  server.ingestRemote(hook(0, 'session-0'), WSL)
  await answered()
  // The host can name this conversation but has not: the field is present and null, which is
  // what offers Copy Agent ID (canPaneOfferAgentId).
  expect(server.getStatusSnapshot()[0]).toHaveProperty('orcaSessionId', null)
  // Inside the 30 s backoff only the click asks again; its answer also re-stamps the row.
  const id = await server.resolvePaneAgentId(paneKey(0), () => undefined)
  expect(id).toMatch(/^claude_/)
  await answered()
  expect(server.getStatusSnapshot()[0]?.orcaSessionId).toBe(id)
})

it('publishes a settled id as a projection: session.tabs wakes, no hook effect repeats', async () => {
  const server = await started(new IdentityTestServer())
  server.identityClient.hold = true
  const window: { hookEventName?: string; orcaSessionId?: string | null; replay?: boolean }[] = []
  server.setListener((row) =>
    window.push({
      hookEventName: row.hookEventName,
      orcaSessionId: publishedOrcaSessionId(row.agentIdentity),
      replay: row.isReplay
    })
  )
  const enriched: (string | undefined)[] = []
  cleanups.unshift(server.subscribeEnrichedStatus((row) => enriched.push(row.hookEventName)))
  const touched: string[] = []
  const snapshotsSeen: (string | null | undefined)[] = []
  cleanups.unshift(
    installHookStatusSessionTabsRepublish(server, () => ({
      getTerminalWorktreeIdForHandle: () => null,
      getTerminalWorktreeIdForPaneKey: () => null,
      scheduleMobileSessionTabsAgentStatusHeartbeatForWorktree: () => {},
      touchMobileSessionTabsForWorktree: (worktreeId) => {
        touched.push(worktreeId)
        // A projection listener reads the settled state, not a cached copy.
        snapshotsSeen.push(server.getStatusSnapshot()[0]?.orcaSessionId)
      }
    }))
  )
  server.ingestRemote(hook(0, 'session-0', 'Stop'), WSL)
  server.publishTmuxTerminal(0, 'tmux-session-0')
  await answered()
  // The initial frames went out pending; the Stop and the tmux publish each ran their effects once.
  expect(enriched.filter((name) => name === 'Stop')).toHaveLength(1)
  const enrichedBefore = enriched.length
  window.length = 0
  touched.length = 0
  snapshotsSeen.length = 0

  server.identityClient.release()
  await answered()
  server.identityClient.release()
  await answered()
  expect(enriched.length).toBe(enrichedBefore)
  expect(window).toHaveLength(2)
  for (const projection of window) {
    expect(projection.hookEventName).toBeUndefined()
    expect(projection.replay).toBe(true)
    expect(projection.orcaSessionId).toMatch(/^(claude|opencode)_/)
  }
  expect(touched).toEqual(['wt-1', 'workspace'])
  expect(snapshotsSeen[0]).toMatch(/^claude_/)
})

describe('terminal agent id authority', () => {
  const sleeping = () => ({
    agent: 'claude' as const,
    providerSession: { key: 'session_id' as const, id: 'sleeping-session' },
    connectionId: null
  })

  it.skipIf(process.platform === 'win32')(
    'names a sleeping agent on the first Copy, even when that Copy starts the store',
    async () => {
      const server = new IdentityTestServer()
      cleanups.unshift(() => server.stop())
      // The path is set without the owner seeing it, so the click itself starts the store.
      Reflect.set(server, 'lastStatusFilePath', join(tempDir(), 'last-status.json'))
      expect(await server.resolvePaneAgentId(paneKey(7), sleeping)).toMatch(/^claude_/)
    }
  )

  it('answers nothing once the owner ended during the wait', async () => {
    const server = await serverWith(1)
    const id = server.getStatusSnapshot()[0]?.orcaSessionId
    expect(id).toBeTruthy()
    // A live-index hit still continues after an await; the owner ends before it does.
    const places = server.terminalAgentPlaces(id!)
    server.endIdentityAuthority()
    expect(await places).toBeNull()

    const copying = await started(new IdentityTestServer())
    copying.identityClient.hold = true
    copying.ingestRemote(hook(0, 'session-0'), WSL)
    const copy = copying.resolvePaneAgentId(paneKey(0), () => undefined)
    await answered()
    copying.identityClient.release()
    queueMicrotask(() => copying.endIdentityAuthority())
    expect(await copy).toBeNull()
  })

  it("never carries an ended store's id: rows, tmux rows, Copy and refusal ask the next store", async () => {
    const server = await serverWith(1, 1)
    const before = server.getStatusSnapshot().map((row) => row.orcaSessionId)
    expect(before.every(Boolean)).toBe(true)
    server.moveStatusFile(join(tempDir(), 'last-status.json'))
    // At once, before the next store answers: no reader sees the ended store's ids.
    expect(server.getStatusSnapshot().map((row) => row.orcaSessionId)).toEqual([null, null])
    expect(await server.terminalAgentPlaces(before[0]!)).toBeNull()
    const copied = await server.resolvePaneAgentId(paneKey(0), () => undefined)
    await answered()
    const after = server.getStatusSnapshot().map((row) => row.orcaSessionId)
    expect(after.every(Boolean)).toBe(true)
    expect(after.filter((id) => before.includes(id))).toEqual([])
    expect(copied).toBe(after[0])
  })
})
