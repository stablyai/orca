import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { seedLegacyAgentStatusForTests } from '../../shared/agent-hook-listener/listener-state'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'

const SOURCE = makePaneKey('tab-source', '11111111-1111-4111-8111-111111111111')
const TARGET = makePaneKey('tab-target', '11111111-1111-4111-8111-111111111111')
const LAUNCH_TOKEN_HASH = createHash('sha256').update('launch-1').digest('hex')

const servers: AgentHookServer[] = []

function newServer(): AgentHookServer {
  const server = new AgentHookServer()
  servers.push(server)
  return server
}

function working(paneKey: string, tabId: string, prompt: string) {
  return {
    paneKey,
    tabId,
    worktreeId: 'wt-1',
    payload: { state: 'working' as const, prompt }
  }
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
})

describe('pane authority identity across a pane move', () => {
  it('drops the alias instead of persisting a self-alias when a pane returns to its first key', () => {
    const server = newServer()
    const persisted = vi.fn()
    server.setPaneKeyAliasPersistenceListener(persisted)

    server.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10, { authorityVerified: true })
    server.transferPaneAuthority(TARGET, SOURCE, 'pty-1', 20, { authorityVerified: true })

    expect(persisted).toHaveBeenLastCalledWith([])
    server.ingestTerminalStatus(working(SOURCE, 'tab-source', 'back home'))
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: SOURCE, prompt: 'back home' })
    ])
  })

  describe('hydrated authority commitments', () => {
    async function startWithCommitmentAt(paneKey: string): Promise<AgentHookServer> {
      const server = newServer()
      const hydrated = {
        paneKey,
        launchToken: 'launch-1',
        tabId: 'tab-source',
        worktreeId: 'wt-1',
        connectionId: 'ssh-target',
        payload: { state: 'working', prompt: 'before', agentType: 'codex' },
        receivedAt: 100,
        stateStartedAt: 100
      } satisfies AgentHookEventPayload & { receivedAt: number; stateStartedAt: number }
      seedLegacyAgentStatusForTests(server._getStateForTests(), hydrated)
      await server.start()
      return server
    }

    const candidate = {
      paneKey: SOURCE,
      launchTokenHash: LAUNCH_TOKEN_HASH,
      connectionId: 'ssh-target',
      terminalProvenance: 'restored' as const
    }

    it('follows its pane, so closing the source tab does not revoke it', async () => {
      const server = await startWithCommitmentAt(SOURCE)

      server.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10, { authorityVerified: true })
      server.dropStatusEntriesByTabPrefix('tab-source')

      expect(server.attestCompatibilityAuthority(candidate)).toEqual({
        paneKey: TARGET,
        source: 'hydrated_commitment'
      })
    })

    it('stays revoked when it was revoked before the move', async () => {
      const server = await startWithCommitmentAt(SOURCE)
      server.retirePaneAuthority(SOURCE)

      server.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10, { authorityVerified: true })

      expect(server.attestCompatibilityAuthority(candidate)).toBeNull()
    })
  })

  describe('retired pane fences', () => {
    function retireMovedPaneAndCloseSource(server: AgentHookServer): void {
      server.ingestTerminalStatus(working(SOURCE, 'tab-source', 'before'))
      server.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10, { authorityVerified: true })
      server.retirePaneAuthority(TARGET)
      server.dropStatusEntriesByTabPrefix('tab-source')
    }

    it('keeps the source key routed to the moved pane after a restore, though the source tab is closed', () => {
      const server = newServer()
      retireMovedPaneAndCloseSource(server)

      expect(server.restorePaneAuthority(TARGET)).toBe(true)
      server.ingestTerminalStatus(working(SOURCE, 'tab-source', 'after restore'))

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: TARGET, prompt: 'after restore' })
      ])
    })

    function newTurnAt(server: AgentHookServer, paneKey: string, tabId: string): void {
      server.ingestRemote(
        {
          paneKey,
          tabId,
          worktreeId: 'wt-1',
          source: 'claude',
          hookEventName: 'SessionStart',
          payload: { state: 'working', prompt: 'new turn', agentType: 'claude' }
        },
        'conn-1'
      )
    }

    it('lets a new turn restart the moved pane when the source tab closed after the retirement', () => {
      const server = newServer()
      retireMovedPaneAndCloseSource(server)

      newTurnAt(server, TARGET, 'tab-target')

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: TARGET, prompt: 'new turn' })
      ])
    })

    it('lets a new turn restart the moved pane when the source tab closed before the retirement', () => {
      const server = newServer()
      server.ingestTerminalStatus(working(SOURCE, 'tab-source', 'before'))
      server.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10, { authorityVerified: true })
      server.dropStatusEntriesByTabPrefix('tab-source')
      server.retirePaneAuthority(TARGET)

      newTurnAt(server, TARGET, 'tab-target')

      expect(server.getStatusSnapshot()).toEqual([
        expect.objectContaining({ paneKey: TARGET, prompt: 'new turn' })
      ])
    })

    it('still suppresses the pane when its owner tab is the one that closed', () => {
      const server = newServer()
      server.ingestTerminalStatus(working(SOURCE, 'tab-source', 'before'))
      server.transferPaneAuthority(SOURCE, TARGET, 'pty-1', 10, { authorityVerified: true })
      server.retirePaneAuthority(TARGET)
      server.dropStatusEntriesByTabPrefix('tab-target')

      expect(server.restorePaneAuthority(TARGET)).toBe(false)
      server.ingestTerminalStatus(working(SOURCE, 'tab-source', 'owner closed'))
      server.ingestTerminalStatus(working(TARGET, 'tab-target', 'owner closed'))

      expect(server.getStatusSnapshot()).toEqual([])
    })
  })
})
