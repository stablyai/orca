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
      daemonProtocolVersions: [7],
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
      daemonProtocolVersions: [],
      inProcessSessions: 0
    })
  })

  it('names every daemon generation when sessions span them', async () => {
    const census = await collectOrcadTerminalCensus(
      0,
      async () => [session(1, 7), session(2, 6), session(3, 7)],
      async () => 0
    )
    expect(census).toMatchObject({
      liveSessions: 3,
      daemonProtocolVersion: null,
      daemonProtocolVersions: [6, 7]
    })
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
      daemonProtocolVersions: [],
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
