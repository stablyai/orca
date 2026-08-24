import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from './server'
import { PANE, recentTs } from './server.test-fixtures'

const CONNECTION_ID = 'ssh-owner'
const SESSION_ID = 'session-owner'
const TRANSCRIPT_PATH = '/remote/session-owner.jsonl'
const MOVED_PANE = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')

describe('transcript-owner persistence', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-transcript-owner-'))
    mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  function lastStatusPath(): string {
    return join(userDataPath, 'agent-hooks', 'last-status.json')
  }

  function writeStatus(file: Record<string, unknown>): void {
    writeFileSync(lastStatusPath(), JSON.stringify({ version: 2, ...file }), 'utf8')
  }

  it('retains SSH owner evidence after hook rows age beyond the status TTL', async () => {
    const observedAt = Date.now() - 30 * 24 * 60 * 60 * 1000
    writeStatus({
      entries: {},
      transcriptOwners: {
        [PANE]: {
          paneKey: PANE,
          agentType: 'claude',
          sessionId: SESSION_ID,
          transcriptPath: TRANSCRIPT_PATH,
          connectionId: CONNECTION_ID,
          observedAt
        }
      }
    })

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      await server.awaitTranscriptOwnerHydration()
      expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
      expect(server.getTranscriptOwnerEvidence(PANE)).toEqual([
        {
          paneKey: PANE,
          agentType: 'claude',
          sessionId: SESSION_ID,
          transcriptPath: TRANSCRIPT_PATH,
          connectionId: CONNECTION_ID,
          observedAt
        }
      ])
    } finally {
      server.stop()
    }
  })

  it.each([
    ['fresh', recentTs()],
    ['aged', Date.now() - 30 * 24 * 60 * 60 * 1000]
  ])(
    'migrates %s pre-ledger remote authority to an unresolved marker',
    async (_label, observedAt) => {
      writeStatus({
        entries: {},
        authorityCommitments: {
          [PANE]: {
            paneKey: PANE,
            launchTokenHash: createHash('sha256').update('remote-launch').digest('hex'),
            connectionId: CONNECTION_ID,
            observedAt
          }
        }
      })

      const server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath })
      try {
        expect(server.hasUnresolvedRemoteTranscriptOwner(PANE)).toBe(true)
        server.flushStatusPersistSync()
        expect(JSON.parse(readFileSync(lastStatusPath(), 'utf8'))).toMatchObject({
          unresolvedRemoteTranscriptOwners: {
            [PANE]: { paneKey: PANE, connectionId: CONNECTION_ID, observedAt }
          }
        })
      } finally {
        server.stop()
      }
    }
  )

  it('moves retained evidence with pane authority and clears it on retirement', async () => {
    writeStatus({
      entries: {},
      transcriptOwners: {
        [PANE]: {
          paneKey: PANE,
          agentType: 'codex',
          sessionId: SESSION_ID,
          transcriptPath: TRANSCRIPT_PATH,
          connectionId: CONNECTION_ID,
          observedAt: recentTs()
        }
      }
    })

    const server = new AgentHookServer()
    await server.start({ env: 'production', userDataPath })
    try {
      server.transferPaneAuthority(PANE, MOVED_PANE)
      expect(server.getTranscriptOwnerEvidence(PANE)).toEqual([
        expect.objectContaining({ paneKey: MOVED_PANE, sessionId: SESSION_ID })
      ])
      expect(server.getTranscriptOwnerEvidence(MOVED_PANE)).toEqual([
        expect.objectContaining({ paneKey: MOVED_PANE, sessionId: SESSION_ID })
      ])
      server.retirePaneAuthority(MOVED_PANE)
      expect(server.getTranscriptOwnerEvidence(MOVED_PANE)).toEqual([])
      server.flushStatusPersistSync()
    } finally {
      server.stop()
    }

    const restarted = new AgentHookServer()
    await restarted.start({ env: 'production', userDataPath })
    try {
      expect(restarted.getTranscriptOwnerEvidence()).toEqual([])
    } finally {
      restarted.stop()
    }
  })
})
