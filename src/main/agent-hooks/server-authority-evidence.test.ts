import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import {
  seedLegacyAgentStatusForTests,
  clearPaneCacheState
} from '../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'
import { postHookEvent, installTestLaunchAuthority, recentTs } from './server.test-fixtures'
import {
  TMUX_TEST_PANE,
  TMUX_TEST_ROOT,
  TMUX_TEST_ROWS,
  tmuxTestBody
} from '../../shared/tmux-status.test-fixture'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import type { AgentStatusSubject } from '../../shared/agent-status-subject'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const tmuxProbe = vi.hoisted(() => vi.fn())
vi.mock('../../shared/tmux-host-attachment-probe', () => ({ probeTmuxHostAttachments: tmuxProbe }))
class CanonicalEvidenceServer extends AgentHookServer {
  get store() {
    return this.canonicalStatusStore
  }
  selected(paneKey: string) {
    return this.authoritySubject(paneKey)
  }
  root(paneKey: string) {
    return this.captureTmuxRoot(paneKey)
  }
  index(paneKey: string, subject: AgentStatusSubject) {
    this.canonicalSubjectsByPane.set(paneKey, new Map([['fixture', subject]]))
  }
}

const PANE_KEY = makePaneKey('tab-authority', '11111111-1111-4111-8111-111111111111')
const SECOND_PANE_KEY = makePaneKey('tab-authority-2', '22222222-2222-4222-8222-222222222222')

describe('AgentHookServer authority evidence', () => {
  const servers: AgentHookServer[] = []
  const persistenceDirectories: string[] = []

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
    for (const directory of persistenceDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  it('keeps captured canonical removal, revision replacement and adopted-root replacement separate from a current retirement', async () => {
    for (const transition of ['removed', 'revision', 'root', 'current'] as const) {
      const server = new CanonicalEvidenceServer()
      servers.push(server)
      let root = TMUX_TEST_ROOT
      server.setTmuxManagedPtyResolver(async () => root)
      tmuxProbe.mockResolvedValue({ clients: [{ pid: 101, pane: '%0' }], rows: TMUX_TEST_ROWS })
      await server.start({ env: 'production' })
      installTestLaunchAuthority(server, [
        { paneKey: TMUX_TEST_PANE, token: 'generation', connectionId: null }
      ])
      expect((await postHookEvent(server, tmuxTestBody(), '/hook/opencode')).status).toBe(204)
      const subject = { ...TMUX_TEST_ROOT.scope, kind: 'pty' as const, paneKey: TMUX_TEST_PANE }
      const original = server.store.getCanonicalParent(subject)!
      expect(server.selected(TMUX_TEST_PANE)).toBe(original)
      const rootCurrent = server.root(TMUX_TEST_PANE)!
      expect(rootCurrent()).toBe(true)
      const retire = server.capturePaneAuthorityRetirement(TMUX_TEST_PANE)
      if (transition === 'removed') {
        expect(server.store.applyMutation({ removeParent: subject })).not.toBeNull()
      } else if (transition === 'revision') {
        expect(
          server.store.applyMutation({
            parent: { subject, status: { ...original.status!, prompt: 'successor revision' } }
          })
        ).not.toBeNull()
      } else if (transition === 'root') {
        root = { ...TMUX_TEST_ROOT, incarnation: 'successor-root' }
        expect((await postHookEvent(server, tmuxTestBody(), '/hook/opencode')).status).toBe(204)
        expect(rootCurrent()).toBe(false)
      }
      const successor = server.store.getCanonicalParent(subject)
      retire()
      if (transition === 'current') {
        expect(server.store.getCanonicalParent(subject)).toBeNull()
        expect(server.getStatusSnapshotForPane(TMUX_TEST_PANE)).toEqual([])
      } else {
        expect(server.store.getCanonicalParent(subject)).toBe(successor)
        if (successor?.status) {
          expect(server.getStatusSnapshotForPane(TMUX_TEST_PANE)[0]?.state).toBe('done')
        }
        expect(
          server.attestCompatibilityAuthority({
            paneKey: TMUX_TEST_PANE,
            launchTokenHash: createHash('sha256').update('generation').digest('hex'),
            connectionId: null,
            terminalProvenance: 'current_runtime'
          })
        ).toBeNull()
      }
      server.stop()
    }
  })

  it('does not turn absent, statusless or excluded representations into retirement authority', async () => {
    const server = new CanonicalEvidenceServer()
    servers.push(server)
    await server.start()
    const absent = server.capturePaneAuthorityRetirement(PANE_KEY)
    const structured = makeStructuredAgentStatusSubject(
      { ...TMUX_TEST_ROOT.scope },
      'structured-only'
    )
    const outer = { ...TMUX_TEST_ROOT.scope, kind: 'pty' as const, paneKey: PANE_KEY }
    expect(server.store.applyMutation({ parent: { subject: structured } })).not.toBeNull()
    server.index(PANE_KEY, structured)
    expect(server.selected(PANE_KEY)).toBeUndefined()
    const excluded = server.capturePaneAuthorityRetirement(PANE_KEY)
    expect(server.store.applyMutation({ parent: { subject: outer } })).not.toBeNull()
    server.index(PANE_KEY, outer)
    const statusless = server.store.getCanonicalParent(outer)
    const retireStatusless = server.capturePaneAuthorityRetirement(PANE_KEY)
    absent()
    excluded()
    retireStatusless()
    expect(server.store.getCanonicalParent(outer)).toBe(statusless)
    expect(server.store.getCanonicalParent(structured)).not.toBeNull()
    // The actual inner producer is indexed but never selected as outer execution authority.
    server.setTmuxManagedPtyResolver(async () => TMUX_TEST_ROOT)
    tmuxProbe.mockResolvedValue({ clients: [{ pid: 101, pane: '%0' }], rows: TMUX_TEST_ROWS })
    await postHookEvent(server, tmuxTestBody(), '/hook/opencode')
    const outerSubject = { ...TMUX_TEST_ROOT.scope, kind: 'pty' as const, paneKey: TMUX_TEST_PANE }
    server.store.applyMutation({ removeParent: outerSubject })
    expect(server.selected(TMUX_TEST_PANE)).toBeUndefined()
    const innerOnly = server.store.getSnapshot().parents
    server.capturePaneAuthorityRetirement(TMUX_TEST_PANE)()
    expect(server.store.getSnapshot().parents).toEqual(innerOnly)
  })

  it('preserves legacy optional identity fallback and revokes a captured hash even without a captured row', async () => {
    const server = new CanonicalEvidenceServer()
    servers.push(server)
    const event = {
      paneKey: PANE_KEY,
      tabId: 'tab-authority',
      worktreeId: 'workspace',
      launchToken: 'old',
      connectionId: null,
      payload: { state: 'working', prompt: '', agentType: 'codex' },
      receivedAt: 100,
      stateStartedAt: 100
    } satisfies AgentHookEventPayload & { receivedAt: number; stateStartedAt: number }
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-authority-evidence-'))
    persistenceDirectories.push(userDataPath)
    const statusDirectory = join(userDataPath, 'agent-hooks')
    mkdirSync(statusDirectory)
    const receivedAt = recentTs()
    const launchTokenHash = createHash('sha256').update('old').digest('hex')
    writeFileSync(
      join(statusDirectory, 'last-status.json'),
      JSON.stringify({
        version: 2,
        entries: {
          [PANE_KEY]: {
            ...event,
            launchToken: undefined,
            launchTokenHash,
            receivedAt,
            stateStartedAt: receivedAt
          }
        }
      })
    )
    await server.start({ env: 'production', userDataPath })
    const attestation = {
      paneKey: PANE_KEY,
      launchTokenHash,
      connectionId: null,
      terminalProvenance: 'restored' as const
    }
    expect(server.attestCompatibilityAuthority(attestation)).toEqual({
      paneKey: PANE_KEY,
      source: 'hydrated_commitment'
    })
    expect(server.getStatusSnapshotForPane(PANE_KEY)).toHaveLength(1)
    clearPaneCacheState(server._getStateForTests(), PANE_KEY)
    expect(server.getStatusSnapshotForPane(PANE_KEY)).toEqual([])
    expect(server.attestCompatibilityAuthority(attestation)).not.toBeNull()
    const hashOnly = server.capturePaneAuthorityRetirement(PANE_KEY)
    hashOnly()
    expect(server.attestCompatibilityAuthority(attestation)).toBeNull()
    server.ingestRemote({ ...event, launchToken: undefined }, null)
    const current = server.capturePaneAuthorityRetirement(PANE_KEY)
    current()
    expect(server.getStatusSnapshotForPane(PANE_KEY)).toEqual([])
  })

  it('uses the original optional process/session/object identities and preserves a newer grant', async () => {
    for (const identity of ['object', 'process', 'session-key', 'host', 'newer-hash'] as const) {
      const server = new AgentHookServer()
      servers.push(server)
      await server.start()
      server.setLaunchAuthorityVerifier(
        () => true,
        () => () => {}
      )
      const process = { pid: 4242, platform: 'linux' as const, startTime: 'birth' }
      const base = {
        paneKey: PANE_KEY,
        worktreeId: 'workspace',
        launchToken: 'original',
        payload: { state: 'working', prompt: 'first', agentType: 'codex' },
        ...(identity === 'process' ? { agentPresence: { agent: 'codex', process } } : {}),
        ...(identity === 'session-key'
          ? { providerSession: { key: 'session_id' as const, id: 'same' } }
          : {})
      }
      server.ingestRemote(base, null)
      const original = server._getStateForTests().lastStatusByPaneKey.get(PANE_KEY)
      const retire = server.capturePaneAuthorityRetirement(PANE_KEY)
      server.ingestRemote(
        {
          ...base,
          payload: { ...base.payload, prompt: 'replacement' },
          ...(identity === 'session-key'
            ? { providerSession: { key: 'conversation_id' as const, id: 'same' } }
            : {}),
          ...(identity === 'newer-hash' ? { launchToken: 'successor' } : {})
        },
        identity === 'host' ? 'ssh-successor' : null
      )
      const successor = server._getStateForTests().lastStatusByPaneKey.get(PANE_KEY)
      expect(successor).not.toBe(original)
      if (identity === 'session-key') {
        expect(successor?.providerSession).toEqual({ key: 'conversation_id', id: 'same' })
      }
      retire()
      if (identity === 'process') {
        expect(server.getStatusSnapshotForPane(PANE_KEY)).toEqual([])
      } else {
        expect(server._getStateForTests().lastStatusByPaneKey.get(PANE_KEY)).toBe(successor)
      }
      if (identity === 'newer-hash') {
        expect(
          server.attestCompatibilityAuthority({
            paneKey: PANE_KEY,
            launchTokenHash: createHash('sha256').update('successor').digest('hex'),
            connectionId: null,
            terminalProvenance: 'current_runtime'
          })
        ).not.toBeNull()
      }
      server.stop()
    }
  })

  it('freezes pre-listen commitments separately from current-runtime observations', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    const hydrated = {
      paneKey: PANE_KEY,
      launchToken: 'launch-before-restart',
      tabId: 'tab-authority',
      worktreeId: 'repo::before',
      connectionId: 'ssh-target',
      payload: { state: 'working', prompt: 'before', agentType: 'codex' },
      receivedAt: 100,
      stateStartedAt: 100
    } satisfies AgentHookEventPayload & { receivedAt: number; stateStartedAt: number }
    seedLegacyAgentStatusForTests(server._getStateForTests(), hydrated)

    await server.start()
    const commitments = server.getHydratedAuthorityCommitments()

    expect(commitments).toEqual([
      {
        paneKey: PANE_KEY,
        launchTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        tabId: 'tab-authority',
        worktreeId: 'repo::before',
        connectionId: 'ssh-target',
        observedAt: 100
      }
    ])
    // Independently registered execution-host secrets, separate from incoming hook bodies.
    const admitted = new Map<string, Set<string>>([
      [
        PANE_KEY,
        new Set(
          ['launch-before-restart', 'launch-after-restart'].map((token) =>
            createHash('sha256').update(token).digest('hex')
          )
        )
      ],
      [
        SECOND_PANE_KEY,
        new Set([createHash('sha256').update('launch-before-restart').digest('hex')])
      ]
    ])
    server.setLaunchAuthorityVerifier(
      (candidate) => admitted.get(candidate.paneKey)?.has(candidate.launchTokenHash) === true,
      () => () => {}
    )
    expect(Object.isFrozen(commitments)).toBe(true)
    expect(Object.isFrozen(commitments[0])).toBe(true)
    expect(server.getCurrentAuthorityObservations()).toEqual([])
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toEqual({ paneKey: PANE_KEY, source: 'hydrated_commitment' })

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        launchToken: 'launch-after-restart',
        tabId: 'tab-authority',
        worktreeId: 'repo::after',
        payload: { state: 'working', prompt: 'after', agentType: 'codex' }
      },
      'ssh-target'
    )

    expect(server.getHydratedAuthorityCommitments()).toBe(commitments)
    expect(JSON.stringify(commitments)).not.toContain('launch-before-restart')
    expect(server.getCurrentAuthorityObservations()).toEqual([
      expect.objectContaining({
        paneKey: PANE_KEY,
        launchTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        connectionId: 'ssh-target',
        worktreeId: 'repo::after'
      })
    ])
    expect(JSON.stringify(server.getCurrentAuthorityObservations())).not.toContain(
      'launch-after-restart'
    )
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toBeNull()
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'current_runtime'
      })
    ).toBeNull()

    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-after-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toBeNull()
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-after-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'current_runtime'
      })
    ).toEqual({ paneKey: PANE_KEY, source: 'current_hook' })

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        launchToken: 'launch-before-restart',
        tabId: 'tab-authority',
        worktreeId: 'repo::current',
        payload: { state: 'working', prompt: 'current', agentType: 'codex' }
      },
      'ssh-target'
    )

    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toEqual({ paneKey: PANE_KEY, source: 'current_hook' })

    server.ingestRemote(
      {
        paneKey: SECOND_PANE_KEY,
        launchToken: 'launch-before-restart',
        tabId: 'tab-authority-2',
        payload: { state: 'working', prompt: 'duplicate', agentType: 'codex' }
      },
      'ssh-target'
    )

    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toBeNull()

    server.clearStatusEntriesForConnection('ssh-target')

    expect(server.getHydratedAuthorityCommitments()).toBe(commitments)
    expect(server.getCurrentAuthorityObservations()).toEqual([])
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toEqual({ paneKey: PANE_KEY, source: 'hydrated_commitment' })

    server.clearPaneState(PANE_KEY)

    expect(server.getHydratedAuthorityCommitments()).toBe(commitments)
    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash: createHash('sha256').update('launch-before-restart').digest('hex'),
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toBeNull()
  })

  it('preserves hydrated authority when stale alias cleanup does not own the stable pane', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    const launchToken = 'launch-before-restart'
    const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
    const hydrated = {
      paneKey: PANE_KEY,
      launchToken,
      tabId: 'tab-authority',
      worktreeId: 'repo::before',
      connectionId: 'ssh-target',
      payload: { state: 'working', prompt: 'before', agentType: 'codex' },
      receivedAt: 100,
      stateStartedAt: 100
    } satisfies AgentHookEventPayload & { receivedAt: number; stateStartedAt: number }
    seedLegacyAgentStatusForTests(server._getStateForTests(), hydrated)
    server.registerPaneKeyAlias('tab-authority:0', PANE_KEY, 'old-pty')
    await server.start()
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        launchToken,
        tabId: 'tab-authority',
        worktreeId: 'repo::current',
        payload: { state: 'working', prompt: 'current', agentType: 'codex' }
      },
      'ssh-target'
    )

    server.clearPaneKeyAliasesForPty('old-pty', { shouldClearStablePaneKey: () => false })

    expect(
      server.attestCompatibilityAuthority({
        paneKey: PANE_KEY,
        launchTokenHash,
        connectionId: 'ssh-target',
        terminalProvenance: 'restored'
      })
    ).toEqual({ paneKey: PANE_KEY, source: 'current_hook' })
  })

  it('revokes the captured launch through a later alias move while preserving its successor', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    const launchToken = 'inherited-launch'
    const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
    let currentLaunch = true
    server.setLaunchAuthorityVerifier(
      () => currentLaunch,
      () => () => {}
    )
    await server.start()
    const post = (paneKey: string, id: string): void =>
      server.ingestRemote(
        {
          paneKey,
          launchToken,
          source: 'opencode',
          worktreeId: 'repo::same',
          providerSession: { key: 'session_id', id },
          payload: { state: 'working', prompt: id, agentType: 'opencode' }
        },
        null
      )
    post(PANE_KEY, 'session-1')
    const retire = server.capturePaneAuthorityRetirement(PANE_KEY)
    post(PANE_KEY, 'session-2')
    server.transferPaneAuthority(PANE_KEY, SECOND_PANE_KEY, 'same-pty')
    currentLaunch = false
    retire()
    post(PANE_KEY, 'session-2')
    expect(server.getStatusSnapshotForPane(SECOND_PANE_KEY)[0]).toMatchObject({
      state: 'working',
      providerSession: { id: 'session-2' }
    })
    expect(server.resolvePaneAuthorityOwner(PANE_KEY)).toBe(SECOND_PANE_KEY)
    expect(
      server.attestCompatibilityAuthority({
        paneKey: SECOND_PANE_KEY,
        launchTokenHash,
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })
    ).toBeNull()
  })
})
