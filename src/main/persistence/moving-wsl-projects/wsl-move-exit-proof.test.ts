import { describe, expect, it, vi } from 'vitest'
import type { SessionInfo } from '../../daemon/types'
import { proveWslMoveTerminalsExited } from './wsl-move-exit-proof'

type CensusSession = Pick<SessionInfo, 'sessionId' | 'isAlive'> &
  Partial<Pick<SessionInfo, 'cwd' | 'wslDistro'>>
type Census = CensusSession[] | null

const repoKey = 'repo::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
const scope = (workspaceKeys: string[], sessionIds: string[] = []) => ({
  distro: 'Ubuntu',
  workspaceKeys: new Set(workspaceKeys),
  sessionIds: new Set(sessionIds)
})
const prove = (census: Census, keys = [repoKey], sessionIds: string[] = [], fallback = 0) =>
  proveWslMoveTerminalsExited(
    {
      listSessions: async () =>
        census?.map((session) => ({ cwd: null, wslDistro: null, ...session })) ?? null,
      countFallbackSessions: () => fallback,
      isScopeFenced: () => true
    },
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

  it('matches a differently cased drvfs alias, so its live session never reads as exited', async () => {
    const sessionId = 'repo:://wsl$/ubuntu/mnt/c/repo/@@7'
    await expect(
      prove([{ sessionId, isAlive: true }], ['repo::\\\\wsl.localhost\\Ubuntu\\mnt\\c\\Repo'])
    ).resolves.toEqual({ verdict: 'live', sessionIds: [sessionId] })
  })

  it('matches a Linux-spelled scope key to a UNC-minted session', async () => {
    const sessionId = `${repoKey}@@8`
    await expect(prove([{ sessionId, isAlive: true }], ['repo::/home/dev/app/'])).resolves.toEqual({
      verdict: 'live',
      sessionIds: [sessionId]
    })
  })

  it('attributes an unminted live session by its folder in the moved workspace', async () => {
    await expect(
      prove([{ sessionId: 'uuid-1', isAlive: true, cwd: '/home/dev/app/src', wslDistro: 'ubuntu' }])
    ).resolves.toEqual({ verdict: 'live', sessionIds: ['uuid-1'] })
  })

  it.each([
    ['no folder', { cwd: null, wslDistro: 'Ubuntu' }],
    [
      'a POSIX folder from a daemon that does not report its distro',
      { cwd: '/home/dev/app', wslDistro: undefined }
    ],
    ['a native-tagged shell in a moved folder', { cwd: '/home/dev/app', wslDistro: null }]
  ])('never proves exit past an unminted live session with %s', async (_label, facts) => {
    await expect(prove([{ sessionId: 'uuid-2', isAlive: true, ...facts }])).resolves.toMatchObject({
      verdict: 'unverifiable'
    })
  })

  it.each([
    ['a native Windows folder', { cwd: 'C:\\src', wslDistro: null }],
    ['a Git Bash folder', { cwd: '/c/src', wslDistro: null }],
    ['another distro', { cwd: '/home/dev/app', wslDistro: 'Debian' }],
    // Other projects in the moving distro keep their terminals through a move.
    ['another folder in the moving distro', { cwd: '/home/dev/other', wslDistro: 'Ubuntu' }],
    ['the moving distro’s home, above the move', { cwd: '/home/dev', wslDistro: 'Ubuntu' }],
    ['a sibling sharing the prefix', { cwd: '/home/dev/app2', wslDistro: 'Ubuntu' }],
    ['a UNC folder in the moving distro', { cwd: '\\\\wsl$\\Ubuntu\\tmp', wslDistro: null }],
    [
      'a POSIX folder outside the move from a daemon that does not report its distro',
      { cwd: '/home/dev/other', wslDistro: undefined }
    ]
  ])('ignores an unminted live session in %s', async (_label, facts) => {
    await expect(prove([{ sessionId: 'uuid-3', isAlive: true, ...facts }])).resolves.toEqual({
      verdict: 'exited'
    })
  })

  it("counts another workspace's shell that changed into a moved folder", async () => {
    const sessionId = 'other::\\\\wsl.localhost\\Ubuntu\\home\\dev\\other@@1'
    await expect(
      prove([{ sessionId, isAlive: true, cwd: '/home/dev/app/src', wslDistro: 'Ubuntu' }])
    ).resolves.toEqual({ verdict: 'live', sessionIds: [sessionId] })
    await expect(
      prove([{ sessionId, isAlive: true, cwd: '/home/dev/other', wslDistro: 'Ubuntu' }])
    ).resolves.toEqual({ verdict: 'exited' })
  })

  it('cannot prove exit when the fence lifts during the census', async () => {
    let fenced = true
    await expect(
      proveWslMoveTerminalsExited(
        {
          listSessions: async () => {
            fenced = false
            return []
          },
          countFallbackSessions: () => 0,
          isScopeFenced: () => fenced
        },
        scope([repoKey])
      )
    ).resolves.toMatchObject({ verdict: 'unverifiable' })
  })

  it('refuses to prove exit before new terminals are fenced', async () => {
    const listSessions = vi.fn(async () => [])
    await expect(
      proveWslMoveTerminalsExited(
        { listSessions, countFallbackSessions: () => 0, isScopeFenced: () => false },
        scope([repoKey])
      )
    ).resolves.toMatchObject({ verdict: 'unverifiable' })
    expect(listSessions).not.toHaveBeenCalled()
  })

  it('reads a failing fallback count as unverifiable', async () => {
    await expect(
      proveWslMoveTerminalsExited(
        {
          listSessions: async () => [],
          countFallbackSessions: () => {
            throw new Error('fallback census failed')
          },
          isScopeFenced: () => true
        },
        scope([repoKey])
      )
    ).resolves.toEqual({ verdict: 'unverifiable', reason: 'fallback census failed' })
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
          countFallbackSessions: () => 0,
          isScopeFenced: () => true
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
