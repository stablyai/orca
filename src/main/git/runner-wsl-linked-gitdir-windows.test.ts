import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listFilesWithGit } from '../ipc/filesystem-list-files-git-fallback'
import { searchWithGitGrep } from '../ipc/filesystem-search-git'
import {
  gitExecFileAsync,
  gitExecFileAsyncBuffer,
  gitStreamStdout,
  toLinuxPath,
  toWindowsWslPath
} from './runner'
import { listWorktrees } from './worktree'
import { resetWslLinkedWorktreeGitRoutingForTests } from './wsl-linked-worktree-git-routing'

const distro = process.env.ORCA_TEST_WSL_DISTRO?.trim()
const fixtureRoots: string[] = []
const wslFixtureRoots: string[] = []

function hostGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function wslExec(args: string[]): string {
  return execFileSync('wsl.exe', ['-d', distro!, '--exec', ...args], { encoding: 'utf8' })
}

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  )
  for (const path of wslFixtureRoots.splice(0)) {
    if (!/^\/tmp\/orca-wsl-native-[A-Za-z0-9]+$/.test(path)) {
      throw new Error(`Refusing to remove unexpected WSL fixture path: ${path}`)
    }
    wslExec(['rm', '-rf', '--', path])
  }
})

describe.runIf(process.platform === 'win32' && Boolean(distro))(
  'Windows-authored linked worktree in WSL',
  () => {
    it('handles the worktree through the production Git runner', async () => {
      const fixtureRoot = await mkdtemp(join(process.cwd(), '.wsl-linked-gitdir-'))
      fixtureRoots.push(fixtureRoot)
      const mainPath = join(fixtureRoot, 'main')
      const linkedPath = join(fixtureRoot, 'linked')

      hostGit(['init', mainPath], fixtureRoot)
      hostGit(['config', 'user.name', 'Orca Test'], mainPath)
      hostGit(['config', 'user.email', 'test@invalid'], mainPath)
      await writeFile(join(mainPath, 'tracked.txt'), 'tracked\n')
      hostGit(['add', 'tracked.txt'], mainPath)
      hostGit(['commit', '-m', 'fixture'], mainPath)
      hostGit(['worktree', 'add', '-b', 'linked', linkedPath], mainPath)
      await writeFile(join(linkedPath, 'untracked.txt'), 'untracked\n')

      const gitFile = await readFile(join(linkedPath, '.git'), 'utf8')
      expect(gitFile).toMatch(/^gitdir: [A-Za-z]:\//)
      expect(() =>
        execFileSync(
          'wsl.exe',
          ['-d', distro!, '--exec', 'git', '-C', toLinuxPath(linkedPath), 'status', '--short'],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        )
      ).toThrow(/not a git repository/i)

      await expect(listFilesWithGit(linkedPath, [], { wslDistro: distro! })).resolves.toEqual(
        expect.arrayContaining(['tracked.txt', 'untracked.txt'])
      )
      resetWslLinkedWorktreeGitRoutingForTests()
      await expect(
        searchWithGitGrep(linkedPath, { query: 'tracked', rootPath: linkedPath }, 10, {
          wslDistro: distro!
        })
      ).resolves.toMatchObject({ totalMatches: 2 })

      let streamedStatus = ''
      await expect(
        gitStreamStdout(['status', '--short'], {
          cwd: linkedPath,
          wslDistro: distro!,
          onStdout: (chunk) => {
            streamedStatus += chunk
          }
        })
      ).resolves.toEqual({ stoppedEarly: false })
      expect(streamedStatus).toBe('?? untracked.txt\n')

      await gitExecFileAsync(['add', '--', 'untracked.txt'], {
        cwd: linkedPath,
        wslDistro: distro!
      })
      await expect(
        gitExecFileAsync(['status', '--short'], { cwd: linkedPath, wslDistro: distro! })
      ).resolves.toMatchObject({ stdout: 'A  untracked.txt\n' })
      await expect(
        gitExecFileAsync(['status', '--short'], { cwd: linkedPath })
      ).resolves.toMatchObject({ stdout: 'A  untracked.txt\n' })
      await expect(
        gitExecFileAsyncBuffer(['show', ':untracked.txt'], {
          cwd: linkedPath,
          wslDistro: distro!
        })
      ).resolves.toMatchObject({ stdout: Buffer.from('untracked\n') })

      const folderPath = join(linkedPath, 'packages', 'app')
      await mkdir(folderPath, { recursive: true })
      await expect(
        gitExecFileAsync(['rev-parse', '--show-toplevel'], {
          cwd: folderPath,
          wslDistro: distro!
        })
      ).resolves.toMatchObject({ stdout: `${linkedPath.replace(/\\/g, '/')}\n` })

      const linkedExecPath = await gitExecFileAsync(['--exec-path'], {
        cwd: linkedPath,
        wslDistro: distro!
      })
      const mainExecPath = await gitExecFileAsync(['--exec-path'], {
        cwd: mainPath,
        wslDistro: distro!
      })
      expect(linkedExecPath.stdout).toMatch(/^[A-Za-z]:\//)
      expect(mainExecPath.stdout).toMatch(/(?:^|\n)\/[^\n]+\n$/)
      await expect(listWorktrees(linkedPath, { wslDistro: distro! })).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: expect.stringMatching(/[\\/]linked$/) })
        ])
      )

      const nestedPath = join(linkedPath, 'nested')
      wslExec(['git', 'init', toLinuxPath(nestedPath)])
      await expect(
        gitExecFileAsync(['--exec-path'], { cwd: nestedPath, wslDistro: distro! })
      ).resolves.toMatchObject({ stdout: expect.stringMatching(/(?:^|\n)\/[^\n]+\n$/) })
    })

    it('keeps WSL-native repositories on WSL Git', async () => {
      const linuxRoot = wslExec(['mktemp', '-d', '/tmp/orca-wsl-native-XXXXXX']).trim()
      wslFixtureRoots.push(linuxRoot)
      const windowsRoot = toWindowsWslPath(linuxRoot, distro!)

      wslExec(['git', 'init', linuxRoot])
      wslExec(['git', '-C', linuxRoot, 'config', 'user.name', 'Orca Test'])
      wslExec(['git', '-C', linuxRoot, 'config', 'user.email', 'test@invalid'])
      await writeFile(join(windowsRoot, 'tracked.txt'), 'tracked\n')
      wslExec(['git', '-C', linuxRoot, 'add', 'tracked.txt'])
      wslExec(['git', '-C', linuxRoot, 'commit', '-m', 'fixture'])
      await writeFile(join(windowsRoot, 'untracked.txt'), 'untracked\n')

      await expect(
        gitExecFileAsync(['status', '--short'], { cwd: windowsRoot, wslDistro: distro! })
      ).resolves.toMatchObject({ stdout: expect.stringMatching(/(?:^|\n)\?\? untracked\.txt\n$/) })
      await expect(
        gitExecFileAsync(['--exec-path'], { cwd: windowsRoot, wslDistro: distro! })
      ).resolves.toMatchObject({ stdout: expect.stringMatching(/(?:^|\n)\/[^\n]+\n$/) })
    })
  }
)
