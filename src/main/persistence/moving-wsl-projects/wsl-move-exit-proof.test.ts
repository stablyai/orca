import { describe, expect, it } from 'vitest'
import type { SessionInfo } from '../../daemon/types'
import { proveWslMoveTerminalsExited } from './wsl-move-exit-proof'

type Census = Pick<SessionInfo, 'sessionId' | 'isAlive'>[] | null

const repoKey = 'repo::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
const scope = (workspaceKeys: string[], sessionIds: string[] = []) => ({
  workspaceKeys: new Set(workspaceKeys),
  sessionIds: new Set(sessionIds)
})
const prove = (census: Census, keys = [repoKey], sessionIds: string[] = [], fallback = 0) =>
  proveWslMoveTerminalsExited(
    { listSessions: async () => census, countFallbackSessions: () => fallback },
    scope(keys, sessionIds)
  )

describe('proveWslMoveTerminalsExited', () => {
  it('proves exit when no live session belongs to a moved workspace', async () => {
    await expect(
      prove([
        { sessionId: `${repoKey}@@1`, isAlive: false },
        { sessionId: 'other::C:\\src@@2', isAlive: true }
      ])
    ).resolves.toEqual({ verdict: 'exited' })
  })

  it('names every live session of a moved workspace', async () => {
    const live = `${repoKey}@@3`
    await expect(prove([{ sessionId: live, isAlive: true }])).resolves.toEqual({
      verdict: 'live',
      sessionIds: [live]
    })
  })

  it.each([
    ['the wsl$ spelling', 'repo::\\\\wsl$\\Ubuntu\\home\\dev\\app@@4'],
    ['another distro-name case', 'repo:://wsl.localhost/ubuntu/home/dev/app@@5']
  ])('matches a session minted under %s', async (_label, sessionId) => {
    await expect(prove([{ sessionId, isAlive: true }])).resolves.toEqual({
      verdict: 'live',
      sessionIds: [sessionId]
    })
  })

  it('keeps the Linux part case-sensitive', async () => {
    await expect(
      prove([{ sessionId: 'repo::\\\\wsl.localhost\\Ubuntu\\home\\dev\\App@@6', isAlive: true }])
    ).resolves.toEqual({ verdict: 'exited' })
  })

  it('matches a folder workspace by its minted key', async () => {
    await expect(
      prove([{ sessionId: 'folder:abc@@1', isAlive: true }], ['folder:abc'])
    ).resolves.toEqual({ verdict: 'live', sessionIds: ['folder:abc@@1'] })
  })

  it('counts a live pane session whose id predates the minted format', async () => {
    await expect(
      prove([{ sessionId: 'legacy-uuid', isAlive: true }], [repoKey], ['legacy-uuid'])
    ).resolves.toEqual({ verdict: 'live', sessionIds: ['legacy-uuid'] })
  })

  it('never reads a census it could not take as exit', async () => {
    await expect(
      proveWslMoveTerminalsExited(
        {
          listSessions: async () => {
            throw new Error('daemon unreachable')
          },
          countFallbackSessions: () => 0
        },
        scope([repoKey])
      )
    ).resolves.toEqual({ verdict: 'unverifiable', reason: 'daemon unreachable' })
    await expect(prove(null)).resolves.toMatchObject({ verdict: 'unverifiable' })
  })

  it('cannot prove exit while terminals run outside the daemon', async () => {
    await expect(prove([], [repoKey], [], 1)).resolves.toMatchObject({ verdict: 'unverifiable' })
  })
})
