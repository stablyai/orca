// A drive letter mapped to a real WSL2 distro's share (`net use X: \\wsl.localhost\<distro>`),
// read by the mover's real pieces: drive reads, scope, path and identity mapping, and the
// Git-for-Windows worktree gate against real Git for Windows and real WSL Git. wsl-orcad-e2e.yml
// runs it after its lanes. Run: ORCA_RUN_WSL_ORCAD_LANE=1 pnpm test <this file> (Windows only).
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.cwd() }
}))

import { runProcess } from '@orca/process-host'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import type { Repo } from '../../../shared/repository/repo-types'
import { buildWslExecArgs } from '../../../shared/shell/wsl/wsl-login-shell-command'
import {
  toWslDistroUncPath,
  type WslMappedDrive
} from '../../../shared/wsl-move/wsl-mapped-drive-paths'
import { rewriteOrcadMigrationWorktreeId } from '../../persistence/migrating-orcad-catalog/path-rewrite/orcad-migration-path-rewrite'
import { createWslMoveStringNormalizer } from '../../persistence/moving-wsl-projects/manifest-scope/wsl-move-canonical-form'
import { readWslMoveMappedDrives } from '../../persistence/moving-wsl-projects/manifest-scope/wsl-move-mapped-drives'
import { createUncToLinuxPathRewriter } from '../../persistence/moving-wsl-projects/manifest-scope/wsl-move-path-rewriter'
import { collectWslMoveScope } from '../../persistence/moving-wsl-projects/manifest-scope/wsl-move-scope'
import {
  findWindowsGitRefusals,
  windowsGitWorktreeVerdict
} from '../../persistence/moving-wsl-projects/manifest-scope/wsl-move-windows-git-worktrees'
import { resolveWslExecutablePath } from '../execution/wsl-executable-path'
import { resolveWslInteropSpawnCwd } from '../execution/wsl-interop-spawn-directory'
import {
  classifyWslMappedDrive,
  readWslMappedDriveShareNow,
  resolveWslMappedDrivePath,
  wslMappedDriveMatches
} from './wsl-mapped-drive-share'

const RUN = process.env.ORCA_RUN_WSL_ORCAD_LANE === '1' && process.platform === 'win32'
const DISTRO = process.env.ORCA_WSL_ORCAD_LANE_PLAIN_DISTRO ?? 'orca-lane-plain'
const SHARE = `\\\\wsl.localhost\\${DISTRO}`
const LANE_DIR = 'orca-mapped-drive-lane'
// A cold distro boots on the first share read; WSL itself answers in seconds once it runs.
const SHARE_TIMEOUT_MS = 60_000

const net = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'net.exe')
const gitForWindows = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe')

let letter = ''
let linuxBase = ''
let mapped = false

async function run(program: string, args: string[], cwd?: string): Promise<string> {
  const result = await runProcess({ program, args, cwd, timeoutMs: 120_000 })
  const output = `${result.stdout}${result.stderr}`.trim()
  if (result.code !== 0) {
    throw new Error(`${win32.basename(program)} ${args.join(' ')} exited ${result.code}: ${output}`)
  }
  return output
}

/** As the distro's default user (orca), through `--exec` so no argument is rewritten. */
function guest(script: string): Promise<string> {
  return run(
    resolveWslExecutablePath(),
    buildWslExecArgs(DISTRO, ['sh', '-c', script]),
    resolveWslInteropSpawnCwd()
  )
}

const drivePath = (...parts: string[]): string =>
  `${letter}:${linuxBase.replace(/\//g, '\\')}\\${parts.join('\\')}`
const linuxPath = (...parts: string[]): string => [linuxBase, ...parts].join('/')
const repoRow = (id: string, path: string): Repo => ({
  id,
  path,
  displayName: id,
  badgeColor: '#000',
  addedAt: 0
})
const drives = (): WslMappedDrive[] => [{ letter, share: SHARE }]

describe.runIf(RUN)('a drive letter mapped to a real WSL2 distro share', () => {
  beforeAll(
    async () => {
      const home = await guest('printf %s "$HOME"')
      linuxBase = `${home}/${LANE_DIR}`
      const commit = 'git -c user.email=lane@orca -c user.name=lane commit -q --allow-empty -m init'
      // App: no worktrees. LinuxTree: a worktree WSL Git created. WinTree: one Git for Windows adds below.
      await guest(
        `set -e; rm -rf "${linuxBase}"; mkdir -p "${linuxBase}"; cd "${linuxBase}"; ` +
          `for r in App LinuxTree WinTree; do git init -q "$r"; (cd "$r" && ${commit}); done; ` +
          `(cd LinuxTree && git worktree add -q "${linuxBase}/LinuxTree-wt")`
      )
      letter = [...'ZYXWVUTSRQPONM'].find((candidate) => !existsSync(`${candidate}:\\`)) ?? ''
      expect(letter, 'no free drive letter on this runner').not.toBe('')
      await run(net, ['use', `${letter}:`, SHARE, '/persistent:no'])
      mapped = true
      console.log(`[mapped-drive-lane] ${letter}: -> ${SHARE}; repos under ${linuxBase}`)
    },
    // Boots the distro, creates three repos in it and maps its share: each step can wait on WSL.
    SHARE_TIMEOUT_MS * 3
  )

  afterAll(
    async () => {
      if (mapped) {
        await run(net, ['use', `${letter}:`, '/delete', '/y']).catch((error: unknown) =>
          console.warn(error)
        )
      }
      if (linuxBase) {
        await guest(`rm -rf "${linuxBase}"`).catch((error: unknown) => console.warn(error))
      }
    },
    // Unmapping the share and cleaning up in the distro each wait on WSL.
    SHARE_TIMEOUT_MS
  )

  it('sees the distro repo through the drive letter', () => {
    expect(
      existsSync(drivePath('App', '.git')),
      `${drivePath('App', '.git')} is not readable through ${letter}:`
    ).toBe(true)
  })

  it(
    'resolves the letter to the distro share with every reader',
    async () => {
      const fresh = await readWslMappedDriveShareNow(letter, undefined, SHARE_TIMEOUT_MS)
      console.log(`[mapped-drive-lane] fresh read: ${JSON.stringify(fresh)}`)
      expect(fresh, 'the fresh read did not answer').not.toBe('unverifiable')
      const share = fresh === 'unverifiable' ? null : fresh.share
      expect(
        wslMappedDriveMatches(share, DISTRO, undefined),
        `fresh share ${share} is not in ${DISTRO}`
      ).toBe(true)
      expect(parseWslUncPath(share ?? '')?.linuxPath ?? '/', 'the drive maps the distro root').toBe(
        '/'
      )
      const classified = await classifyWslMappedDrive(letter)
      expect(wslMappedDriveMatches(classified?.share ?? null, DISTRO, undefined), 'classify').toBe(
        true
      )
      const viaResolver = await resolveWslMappedDrivePath(drivePath('App'))
      expect(parseWslUncPath(viaResolver ?? '')?.linuxPath, 'the cached resolver').toBe(
        linuxPath('App')
      )
      const read = await readWslMoveMappedDrives(
        { repos: [repoRow('app', drivePath('App'))], folderWorkspaces: [] },
        DISTRO,
        {
          classify: (l) => classifyWslMappedDrive(l),
          readNow: (l) => readWslMappedDriveShareNow(l)
        }
      )
      expect(
        read.mappedDrives.map((drive) => drive.letter),
        'the mover reads the mapping'
      ).toEqual([letter])
    },
    // Each lookup crosses the 9P share, which waits on WSL; a cold distro can take seconds.
    SHARE_TIMEOUT_MS * 2
  )

  it('puts the drive-letter repo in the move scope only with the mapping', () => {
    const state = {
      repos: [repoRow('app', drivePath('App'))],
      folderWorkspaces: [],
      projectGroups: []
    }
    expect(collectWslMoveScope(state, DISTRO, { mappedDrives: drives() }).repoIds).toEqual(['app'])
    expect(
      collectWslMoveScope(state, DISTRO).repoIds,
      'unmapped, the drive path is not WSL'
    ).toEqual([])
  })

  it('maps drive paths and worktree ids to the Linux paths the host holds', () => {
    const rewriter = createUncToLinuxPathRewriter(DISTRO, drives())
    expect(rewriter.path(drivePath('App', 'src'), 'absolute')).toBe(linuxPath('App', 'src'))
    expect(rewriteOrcadMigrationWorktreeId(`app::${drivePath('App')}`, rewriter)).toBe(
      `app::${linuxPath('App')}`
    )
    expect(toWslDistroUncPath(drivePath('App'), drives())).toBe(
      `${SHARE}${linuxPath('App').replace(/\//g, '\\')}`
    )
    const normalize = createWslMoveStringNormalizer({
      distro: DISTRO,
      hostAliases: [],
      mappedDrives: drives()
    })
    expect(normalize(`app::${drivePath('App')}`)).toBe(
      normalize(`app::${toWslDistroUncPath(drivePath('App'), drives())}`)
    )
  })

  it(
    'refuses a repo whose worktree Git for Windows added, and passes WSL Git’s',
    async () => {
      const git = existsSync(gitForWindows) ? gitForWindows : 'git.exe'
      // The share's owner is not this Windows user; the gate reads links, not ownership.
      await run(
        git,
        ['-c', 'safe.directory=*', 'worktree', 'add', '--quiet', drivePath('WinTree-wt')],
        drivePath('WinTree')
      )
      const admin = drivePath('WinTree', '.git', 'worktrees')
      const links = readdirSync(admin).map((entry) =>
        readFileSync(join(admin, entry, 'gitdir'), 'utf8').trim()
      )
      console.log(`[mapped-drive-lane] Git for Windows wrote: ${JSON.stringify(links)}`)
      const share = (name: string): string => toWslDistroUncPath(drivePath(name), drives())
      expect(
        await windowsGitWorktreeVerdict(share('WinTree'), DISTRO),
        'Git for Windows worktree'
      ).toBe('windows-git-worktrees')
      expect(await windowsGitWorktreeVerdict(share('LinuxTree'), DISTRO), 'WSL Git worktree').toBe(
        'ok'
      )
      expect(await windowsGitWorktreeVerdict(share('App'), DISTRO), 'no worktrees').toBe('ok')
      const refusals = await findWindowsGitRefusals(
        [
          repoRow('win', drivePath('WinTree')),
          repoRow('linux', drivePath('LinuxTree')),
          repoRow('app', drivePath('App'))
        ],
        DISTRO,
        drives(),
        windowsGitWorktreeVerdict
      )
      expect(Object.fromEntries(refusals)).toEqual({ win: 'windows-git-worktrees' })
    },
    // Runs Git for Windows and WSL Git across the share, each of which waits on WSL.
    SHARE_TIMEOUT_MS * 2
  )
})
