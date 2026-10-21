import { describe, expect, it } from 'vitest'
import type { DaemonSessionInfo } from '../daemon/types'
import { collectOrcadTerminalCensus } from './orcad-terminal-census'

function session(createdAt: number, protocolVersion = 7): DaemonSessionInfo {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the census reads only createdAt and protocolVersion.
  return { sessionId: `s-${createdAt}`, createdAt, protocolVersion } as DaemonSessionInfo
}

describe('orcad terminal census', () => {
  it('counts live sessions, those since activation, and their single owning protocol', async () => {
    await expect(
      collectOrcadTerminalCensus(
        100,
        async () => [session(50), session(100), session(150)],
        async () => 0
      )
    ).resolves.toEqual({
      liveSessions: 3,
      startedSinceActivation: 2,
      daemonProtocolVersion: 7,
      inProcessSessions: 0
    })
  })

  it('reports zero, not unknown, for an answered empty daemon', async () => {
    await expect(
      collectOrcadTerminalCensus(
        100,
        async () => [],
        async () => 0
      )
    ).resolves.toEqual({
      liveSessions: 0,
      startedSinceActivation: 0,
      daemonProtocolVersion: null,
      inProcessSessions: 0
    })
  })

  it('leaves the protocol unknown when sessions span daemon generations', async () => {
    const census = await collectOrcadTerminalCensus(
      0,
      async () => [session(1, 7), session(2, 6)],
      async () => 0
    )
    expect(census.daemonProtocolVersion).toBeNull()
    expect(census.liveSessions).toBe(2)
  })

  it('leaves the since-activation count unknown when a session has no creation time', async () => {
    const census = await collectOrcadTerminalCensus(
      0,
      async () => [session(0)],
      async () => 0
    )
    expect(census).toMatchObject({ liveSessions: 1, startedSinceActivation: null })
  })

  it.each([
    ['no inventory', async () => null],
    [
      'a failed inventory',
      async () => {
        throw new Error('daemon unreachable')
      }
    ]
  ])('reads %s as unverifiable, never as zero', async (_label, list) => {
    await expect(collectOrcadTerminalCensus(0, list, async () => 0)).resolves.toEqual({
      liveSessions: null,
      startedSinceActivation: null,
      daemonProtocolVersion: null,
      inProcessSessions: null
    })
  })

  it('counts terminals a degraded daemon left running in orcad itself', async () => {
    // Empty daemon, one in-process agent: a restart would kill it, so the census must not read 0.
    await expect(
      collectOrcadTerminalCensus(
        100,
        async () => [],
        async () => 1
      )
    ).resolves.toEqual({
      liveSessions: 1,
      startedSinceActivation: null,
      daemonProtocolVersion: null,
      inProcessSessions: 1
    })
  })

  it('reads an unlistable in-process provider as unverifiable', async () => {
    const census = await collectOrcadTerminalCensus(
      0,
      async () => [],
      async () => {
        throw new Error('local provider failed')
      }
    )
    expect(census.liveSessions).toBeNull()
  })
})
