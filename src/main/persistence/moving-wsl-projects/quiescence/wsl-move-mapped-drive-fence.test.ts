/** Every recovery and post-commit site maps `W:\` paths with the mapping the cutover journaled. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-internal-gate'
import { parseWslMoveCutover } from '../../../../shared/wsl-move/wsl-move-cutover'
import { wslMoveCutoverFixture as cutover } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import { seedWslMoveCutover } from '../../__fixtures__/wsl-mover/wsl-move-journal-seeding'
import {
  listWslMoveCutovers,
  writeWslMoveCutover
} from '../cutover-recovery/wsl-move-cutover-journal'
import {
  listPendingWslMoveRendererRewrites,
  wslMoveDesktopRewriteContext
} from '../desktop-state/wsl-move-desktop-rewrite'
import { resetWslMoveDesktopRewriteStoresForTests } from '../desktop-state/wsl-move-desktop-rewrite-stores'
import { proveWslMoveTerminalsExited } from './wsl-move-exit-proof'
import { wslMoveFenceFromCutovers } from './wsl-move-fence'
import {
  isWslMoveCwdFenced,
  loadWslMoveFence,
  resetWslMoveFenceForTests
} from './wsl-move-scope-guard'

const W = { letter: 'W', share: '\\\\wsl.localhost\\Ubuntu' }

let userDataPath: string
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), 'wsl-move-mapped-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  resetWslMoveFenceForTests()
  resetWslMoveDesktopRewriteStoresForTests()
  rmSync(userDataPath, { recursive: true, force: true })
})

describe('the exit proof with mapped drives', () => {
  const sources = {
    listSessions: async () => [
      { sessionId: 'other', isAlive: true, cwd: 'W:\\home\\me\\App\\src', wslDistro: null }
    ],
    countFallbackSessions: () => 0,
    isScopeFenced: () => true
  }
  const scope = {
    distro: 'Ubuntu',
    workspaceKeys: new Set(['repo-1::W:\\home\\me\\App']),
    sessionIds: new Set<string>()
  }

  it('counts a Windows shell in a moved W: folder as in scope', async () => {
    expect(await proveWslMoveTerminalsExited(sources, { ...scope, mappedDrives: [W] })).toEqual({
      verdict: 'live',
      sessionIds: ['other']
    })
    expect(await proveWslMoveTerminalsExited(sources, scope)).toEqual({ verdict: 'exited' })
  })
})

describe('the fence and the desktop rewrite read the mapping from the cutover', () => {
  it('fences a spawn in a moved W: folder from the journaled mapping', () => {
    seedWslMoveCutover(userDataPath, cutover('move-1', 'source-fenced', { mappedDrives: [W] }))
    const fence = wslMoveFenceFromCutovers(listWslMoveCutovers(userDataPath))
    expect(fence.fencedRoots).toEqual([
      { distro: 'Ubuntu', roots: ['//wsl.localhost/ubuntu/home/dev/repo-1'], mappedDrives: [W] }
    ])
    loadWslMoveFence(userDataPath)
    expect(isWslMoveCwdFenced('W:\\home\\dev\\repo-1\\src')).toBe(true)
    expect(isWslMoveCwdFenced('X:\\home\\dev\\repo-1\\src')).toBe(false)
  })

  it('rewrites W: paths after commit, for main stores and the renderer', () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    const committed = cutover('move-1', 'destination-committed', { mappedDrives: [W] })
    seedWslMoveCutover(userDataPath, committed)
    const context = wslMoveDesktopRewriteContext(userDataPath, committed)
    expect(context.rewritePath.path('W:\\home\\dev\\repo-1\\a.ts', 'absolute')).toBe(
      '/home/dev/repo-1/a.ts'
    )
    expect(listPendingWslMoveRendererRewrites(userDataPath)).toMatchObject([
      { migrationId: 'move-1', mappedDrives: [W] }
    ])
  })
})

describe('the cutover record with mapped drives', () => {
  it('round-trips as version 2, which builds that only read version 1 refuse', () => {
    const record = cutover('move-1', 'prepared', { mappedDrives: [W] })
    expect(record.version).toBe(2)
    const parsed = parseWslMoveCutover(JSON.parse(JSON.stringify(record)))
    expect(parsed).toMatchObject({ version: 2, mappedDrives: [W] })
    // Ordinary moves keep version 1.
    expect(parseWslMoveCutover(JSON.parse(JSON.stringify(cutover())))).toMatchObject({
      version: 1
    })
  })

  it('fails closed on a version that disagrees with its mapping, or a malformed mapping', () => {
    const record = cutover('move-1', 'prepared', { mappedDrives: [W] })
    expect(() => parseWslMoveCutover({ ...record, version: 1 })).toThrow()
    expect(() => parseWslMoveCutover({ ...cutover(), version: 2 })).toThrow()
    expect(() =>
      parseWslMoveCutover({ ...record, mappedDrives: [{ letter: 'W', share: 'C:\\' }] })
    ).toThrow()
    expect(() => parseWslMoveCutover({ ...record, mappedDrives: 'W' })).toThrow()
  })

  it('never lets a later phase change the journaled mapping', () => {
    writeWslMoveCutover(userDataPath, cutover('move-1', 'prepared', { mappedDrives: [W] }))
    expect(() =>
      writeWslMoveCutover(
        userDataPath,
        cutover('move-1', 'source-fenced', {
          mappedDrives: [{ letter: 'W', share: '\\\\wsl.localhost\\Ubuntu\\home' }]
        })
      )
    ).toThrow('wsl_move_binding_changed')
  })
})
