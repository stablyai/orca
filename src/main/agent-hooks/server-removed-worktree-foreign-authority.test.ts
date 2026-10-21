import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { makePaneKey } from '../../shared/stable-pane-id'
import { LEAF_1 } from './server.test-fixtures'

const REMOVED = 'repo::/removed'
const KEPT = 'repo::/kept'
const PANE = makePaneKey('tab-foreign', LEAF_1)
const TOKEN = 'foreign-launch'
const HASH = createHash('sha256').update(TOKEN).digest('hex')
const working = { state: 'working', prompt: 'live', agentType: 'codex' } as const

describe('removed-worktree foreign authority', () => {
  let userDataPath: string
  beforeEach(() => {
    _internals.resetCachesForTests()
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-foreign-authority-'))
  })
  afterEach(() => rmSync(userDataPath, { recursive: true, force: true }))

  it('preserves ordinary tokenless OSC after a tokened new turn revives a pane', () => {
    const server = new AgentHookServer()
    server.retirePaneAuthority(PANE)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-foreign',
        worktreeId: KEPT,
        launchToken: TOKEN,
        source: 'codex',
        hookEventName: 'SessionStart',
        payload: working
      },
      null
    )
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-foreign',
      worktreeId: KEPT,
      connectionId: null,
      payload: { ...working, state: 'done' }
    })
    expect(server.getStatusSnapshot()).toMatchObject([{ worktreeId: KEPT, state: 'done' }])
    server.stop()
  })

  it('keeps foreign hydrated evidence when a removed commitment outlives its row', async () => {
    const seed = new AgentHookServer()
    await seed.start({ env: 'production', userDataPath })
    seed.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-foreign',
        worktreeId: KEPT,
        launchToken: TOKEN,
        payload: working
      },
      'user@box'
    )
    seed.flushStatusPersistSync()
    seed.stop()
    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-foreign',
          worktreeId: REMOVED,
          launchToken: 'removed-launch',
          payload: working
        },
        null
      )
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-foreign',
        worktreeId: KEPT,
        connectionId: 'user@box',
        payload: working
      })
      server.dropStatusEntriesForRemovedWorktree(REMOVED, 'local')
      expect(server.getStatusSnapshot()).toMatchObject([
        { worktreeId: KEPT, connectionId: 'user@box' }
      ])
      expect(
        server.attestCompatibilityAuthority({
          paneKey: PANE,
          launchTokenHash: HASH,
          connectionId: 'user@box',
          terminalProvenance: 'restored'
        })
      ).toEqual({ paneKey: PANE, source: 'hydrated_commitment' })
      expect(server.getCurrentAuthorityObservations()).toEqual([])
      server.flushStatusPersistSync()
      const file = JSON.parse(
        readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8')
      )
      expect(file.authorityCommitments[PANE]).toBeUndefined()
    } finally {
      server.stop()
    }
  })

  it.each([
    { owner: REMOVED, connectionId: null },
    { owner: KEPT, connectionId: 'user@box' },
    { owner: REMOVED, connectionId: 'user@box' }
  ])(
    'revokes hydrated evidence only for removed $owner on $connectionId',
    async ({ owner, connectionId }) => {
      const token = connectionId === null ? 'removed-launch' : TOKEN
      const hash = createHash('sha256').update(token).digest('hex')
      const seed = new AgentHookServer()
      await seed.start({ env: 'production', userDataPath })
      seed.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-foreign',
          worktreeId: owner,
          launchToken: token,
          payload: working
        },
        connectionId
      )
      seed.flushStatusPersistSync()
      seed.stop()

      const server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath })
      const attest = () =>
        server.attestCompatibilityAuthority({
          paneKey: PANE,
          launchTokenHash: hash,
          connectionId,
          terminalProvenance: 'restored'
        })
      try {
        expect(attest()).toEqual({ paneKey: PANE, source: 'hydrated_commitment' })
        server.ingestRemote(
          {
            paneKey: PANE,
            tabId: 'tab-foreign',
            worktreeId: KEPT,
            launchToken: TOKEN,
            payload: working
          },
          'user@box'
        )
        server.clearStatusEntriesForConnection('user@box')
        server.ingestTerminalStatus({
          paneKey: PANE,
          tabId: 'tab-foreign',
          worktreeId: REMOVED,
          connectionId: null,
          payload: working
        })
        server.dropStatusEntriesForRemovedWorktree(REMOVED, 'local')
        expect(attest()).toEqual(
          owner === REMOVED && connectionId === null
            ? null
            : { paneKey: PANE, source: 'hydrated_commitment' }
        )
        server.flushStatusPersistSync()
        const file = JSON.parse(
          readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8')
        )
        expect(file.authorityCommitments[PANE]).toMatchObject({
          worktreeId: KEPT,
          connectionId: 'user@box',
          launchTokenHash: HASH
        })
        server.ingestRemote(
          {
            paneKey: PANE,
            tabId: 'tab-foreign',
            worktreeId: KEPT,
            launchToken: TOKEN,
            payload: working
          },
          'user@box'
        )
        expect(
          server.attestCompatibilityAuthority({
            paneKey: PANE,
            launchTokenHash: HASH,
            connectionId: 'user@box',
            terminalProvenance: 'current_runtime'
          })
        ).toEqual({ paneKey: PANE, source: 'current_hook' })
      } finally {
        server.stop()
      }
    }
  )

  it.each([false, true])(
    'keeps a foreign claim after removed OSC with disconnect=%s',
    async (disconnect) => {
      const server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath })
      const remote = (state: 'working' | 'done') =>
        server.ingestRemote(
          {
            paneKey: PANE,
            tabId: 'tab-foreign',
            worktreeId: KEPT,
            launchToken: TOKEN,
            payload: { ...working, state }
          },
          'user@box'
        )
      const terminal = (worktreeId: string, connectionId: string | null) =>
        server.ingestTerminalStatus({
          paneKey: PANE,
          tabId: 'tab-foreign',
          worktreeId,
          connectionId,
          payload: working
        })
      const attest = () =>
        server.attestCompatibilityAuthority({
          paneKey: PANE,
          launchTokenHash: HASH,
          connectionId: 'user@box',
          terminalProvenance: 'current_runtime'
        })
      try {
        remote('working')
        if (disconnect) {
          server.clearStatusEntriesForConnection('user@box')
        }
        terminal(REMOVED, null)
        if (!disconnect) {
          expect(attest()).not.toBeNull()
        }

        server.dropStatusEntriesForRemovedWorktree(REMOVED, 'local')
        if (!disconnect) {
          expect(attest()).not.toBeNull()
        }
        server.flushStatusPersistSync()
        const file = JSON.parse(
          readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8')
        )
        expect(file.authorityCommitments[PANE]).toMatchObject({
          worktreeId: KEPT,
          connectionId: 'user@box',
          launchTokenHash: HASH
        })
        expect(file.entries[PANE]).toBeUndefined()

        terminal(REMOVED, null)
        expect(server.getStatusSnapshot()).toHaveLength(0)
        server.ingestRemote(
          { paneKey: PANE, tabId: 'tab-foreign', worktreeId: REMOVED, payload: working },
          'user@box'
        )
        expect(server.getStatusSnapshot()).toHaveLength(0)
        server.ingestRemote(
          { paneKey: PANE, tabId: 'tab-foreign', worktreeId: KEPT, payload: working },
          'user@box'
        )
        expect(server.getStatusSnapshot()).toMatchObject([
          { worktreeId: KEPT, connectionId: 'user@box' }
        ])
        terminal(KEPT, 'user@box')
        expect(server.getStatusSnapshot()).toMatchObject([
          { worktreeId: KEPT, connectionId: 'user@box' }
        ])
        remote('done')
        expect(server.getStatusSnapshot()).toMatchObject([{ worktreeId: KEPT, state: 'done' }])
        expect(attest()).not.toBeNull()
      } finally {
        server.stop()
      }
    }
  )
})
