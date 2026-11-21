import { execFile, execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock, lstatMock, statMock, realpathMock, readFileMock, rmMock } = vi.hoisted(
  () => ({
    runProcessMock: vi.fn(),
    lstatMock: vi.fn(),
    statMock: vi.fn(),
    realpathMock: vi.fn(),
    readFileMock: vi.fn(),
    rmMock: vi.fn()
  })
)

// Process-host tests own encoding, timeouts, and console hiding; assert guest commands here.
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock
}))

vi.mock('node:fs/promises', () => ({
  lstat: lstatMock,
  stat: statMock,
  realpath: realpathMock,
  readFile: readFileMock,
  rm: rmMock
}))

import { getLocalWorktreePathAccess, removeLocalWorktreePath } from './local-worktree-filesystem'
import '../../filesystem/host-tree-removal'
import { isWorktreePathMissing } from './worktree-removal-safety'

function completeExecFile(stdout = ''): void {
  runProcessMock.mockResolvedValue({ code: 0, signal: null, stdout, stderr: '', timedOut: false })
}

function failExecFile(exitCode: number, stderr = 'missing'): void {
  runProcessMock.mockResolvedValue({
    code: exitCode,
    signal: null,
    stdout: '',
    stderr,
    timedOut: false
  })
}

async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('local worktree filesystem runtime access', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
    lstatMock.mockReset()
    statMock.mockReset()
    realpathMock.mockReset()
    readFileMock.mockReset()
    rmMock.mockReset()
    completeExecFile()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // Captured verbatim from live hosts: GNU coreutils 9.4 (Ubuntu 24.04) and BusyBox v1.36.1.
  it.each([
    [
      'No such file or directory',
      "stat: cannot statx '/mnt/c/repo/missing/.git': No such file or directory\n"
    ],
    ['Not a directory', "stat: can't stat '/mnt/c/repo/missing/.git': Not a directory\n"]
  ])('reports WSL stat %s as ENOENT', async (_reason, stderr) => {
    await withPlatform('win32', async () => {
      failExecFile(1, stderr)
      const access = getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' })

      for (const inspect of [access.statPath, access.layoutStatPath, access.realPath]) {
        await expect(inspect('/mnt/c/repo/missing/.git')).rejects.toMatchObject({ code: 'ENOENT' })
      }
      await expect(isWorktreePathMissing('/mnt/c/repo/missing', access.statPath)).resolves.toBe(
        true
      )
    })
  })

  it('does not report a WSL checkout removed when only its marker vanished mid-delete', async () => {
    await withPlatform('win32', async () => {
      const results = [
        {
          code: 1,
          stdout: '',
          stderr: "find: '/mnt/c/repo/checkout/.git': No such file or directory\n"
        },
        { code: 0, stdout: 'directory\n', stderr: '' }
      ]
      runProcessMock.mockImplementation(async () => ({
        signal: null,
        timedOut: false,
        ...results.shift()
      }))

      await expect(
        removeLocalWorktreePath('/mnt/c/repo/checkout', { wslDistro: 'Ubuntu' }, undefined, {
          markerLast: true
        })
      ).rejects.toThrow('No such file or directory')
    })
  })

  it('reports a WSL checkout removed when its root is gone', async () => {
    await withPlatform('win32', async () => {
      failExecFile(1, "rmdir: failed to remove '/mnt/c/repo/checkout': No such file or directory\n")

      await expect(
        removeLocalWorktreePath('/mnt/c/repo/checkout', { wslDistro: 'Ubuntu' }, undefined, {
          markerLast: true
        })
      ).resolves.toBeUndefined()
    })
  })

  it('does not treat an unreadable WSL stat target as missing', async () => {
    await withPlatform('win32', async () => {
      failExecFile(1, "stat: can't stat '/mnt/c/repo/locked': Permission denied\n")
      const access = getLocalWorktreePathAccess({ wslDistro: 'Ubuntu' })

      for (const inspect of [access.statPath, access.layoutStatPath, access.realPath]) {
        await expect(inspect('/mnt/c/repo/locked')).rejects.toThrow('Permission denied')
      }
      await expect(isWorktreePathMissing('/mnt/c/repo/locked', access.statPath)).resolves.toBe(
        false
      )
    })
  })
})

const execFileAsync = promisify(execFile)

describe.skipIf(process.platform === 'win32')(
  'WSL markerLast guest script race protection (real temp directory)',
  () => {
    let scratchDir = ''
    let shimDir = ''
    const realRm =
      process.platform === 'win32'
        ? 'rm'
        : execFileSync('sh', ['-c', 'command -v rm'], { encoding: 'utf8' }).trim()

    beforeEach(() => {
      scratchDir = mkdtempSync(join(tmpdir(), 'orca-wsl-markerlast-'))
      shimDir = join(scratchDir, 'bin')
      mkdirSync(shimDir, { recursive: true })
      if (process.platform === 'darwin') {
        // BSD stat uses -f instead of GNU/BusyBox -c; Linux runs the native stat binary directly.
        const bsdStatShim = join(shimDir, 'stat')
        writeFileSync(
          bsdStatShim,
          [
            '#!/bin/sh',
            'follow=""',
            'if [ "$1" = "-L" ]; then follow="-L"; shift; fi',
            'if [ "$1" = "-c" ]; then fmt="$2"; shift 2; [ "$1" = "--" ] && shift; target="$1"',
            '  /usr/bin/stat $follow "$target" >/dev/null || exit $?',
            '  if [ "$fmt" = "%F" ]; then',
            '    if [ -z "$follow" ] && [ -L "$target" ]; then echo "symbolic link"',
            '    elif [ -d "$target" ]; then echo "directory"',
            '    elif [ -f "$target" ]; then echo "regular file"',
            '    else echo "other"; fi',
            '    exit 0',
            '  fi',
            '  exec /usr/bin/stat $follow -f "$fmt" "$target"',
            'fi',
            'exec /usr/bin/stat $follow "$@"'
          ].join('\n') + '\n'
        )
        chmodSync(bsdStatShim, 0o755)
      }
    })

    afterEach(() => {
      if (scratchDir) {
        rmSync(scratchDir, { recursive: true, force: true })
      }
    })

    function wireGuestShell(extraEnv: Record<string, string> = {}): void {
      runProcessMock.mockImplementation(async ({ args }: { args: string[] }) => {
        const shIndex = args.indexOf('sh')
        try {
          const { stdout, stderr } = await execFileAsync('sh', args.slice(shIndex + 1), {
            env: {
              ...process.env,
              PATH: `${shimDir}:${process.env.PATH ?? ''}`,
              ...extraEnv
            }
          })
          return { code: 0, signal: null, stdout, stderr, timedOut: false }
        } catch (error) {
          const isObj = typeof error === 'object' && error !== null
          return {
            code: isObj && 'code' in error && typeof error.code === 'number' ? error.code : 1,
            signal: null,
            stdout: isObj && 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '',
            stderr: isObj && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : '',
            timedOut: false
          }
        }
      })
    }

    function installPostMarkerRmRaceShim(checkoutPath: string, restoredDotGit?: string): void {
      const rmShim = join(shimDir, 'rm')
      writeFileSync(
        rmShim,
        [
          '#!/bin/sh',
          '"$REAL_RM" "$@"',
          'status=$?',
          'for arg in "$@"; do',
          '  case "$arg" in',
          '    */.git)',
          '      if [ ! -e "$RACE_ONCE" ]; then',
          '        : > "$RACE_ONCE"',
          '        if [ -n "$RACE_DOTGIT" ]; then printf "%s" "$RACE_DOTGIT" > "$RACE_TARGET/.git"; fi',
          '        printf "restored\\n" > "$RACE_TARGET/restored.txt"',
          '      fi',
          '      ;;',
          '  esac',
          'done',
          'exit "$status"'
        ].join('\n') + '\n'
      )
      chmodSync(rmShim, 0o755)
      wireGuestShell({
        REAL_RM: realRm,
        RACE_TARGET: checkoutPath,
        RACE_ONCE: join(shimDir, 'triggered'),
        RACE_DOTGIT: restoredDotGit ?? ''
      })
    }

    it('preserves a checkout restored in the gap between marker removal and rmdir', async () => {
      const checkoutPath = join(scratchDir, 'checkout')
      mkdirSync(checkoutPath)
      writeFileSync(join(checkoutPath, '.git'), 'gitdir: /repo/.git/worktrees/old\n')
      writeFileSync(join(checkoutPath, 'leftover.txt'), 'stale\n')
      installPostMarkerRmRaceShim(checkoutPath, 'gitdir: /other/.git/worktrees/restored\n')

      await withPlatform('win32', async () => {
        await expect(
          removeLocalWorktreePath(checkoutPath, { wslDistro: 'Ubuntu' }, undefined, {
            markerLast: true
          })
        ).rejects.toThrow('A different checkout is now at')
      })

      expect(readFileSync(join(checkoutPath, 'restored.txt'), 'utf8')).toBe('restored\n')
      expect(readFileSync(join(checkoutPath, '.git'), 'utf8')).toBe(
        'gitdir: /other/.git/worktrees/restored\n'
      )
      expect(existsSync(join(checkoutPath, 'leftover.txt'))).toBe(false)
    })

    it('preserves files written after marker removal when no new .git marker is present', async () => {
      const checkoutPath = join(scratchDir, 'checkout')
      mkdirSync(checkoutPath)
      writeFileSync(join(checkoutPath, '.git'), 'gitdir: /repo/.git/worktrees/old\n')
      writeFileSync(join(checkoutPath, 'leftover.txt'), 'stale\n')
      installPostMarkerRmRaceShim(checkoutPath)

      await withPlatform('win32', async () => {
        await expect(
          removeLocalWorktreePath(checkoutPath, { wslDistro: 'Ubuntu' }, undefined, {
            markerLast: true
          })
        ).rejects.toThrow('is no longer a Git worktree')
      })

      expect(readFileSync(join(checkoutPath, 'restored.txt'), 'utf8')).toBe('restored\n')
    })

    it('refuses before deleting files when the marker does not match expectedMarker', async () => {
      const checkoutPath = join(scratchDir, 'checkout')
      mkdirSync(checkoutPath)
      writeFileSync(join(checkoutPath, '.git'), 'gitdir: /other/.git/worktrees/replaced\n')
      writeFileSync(join(checkoutPath, 'work.txt'), 'unsaved\n')
      const ino = lstatSync(join(checkoutPath, '.git'), { bigint: true }).ino
      wireGuestShell()

      await withPlatform('win32', async () => {
        await expect(
          removeLocalWorktreePath(checkoutPath, { wslDistro: 'Ubuntu' }, undefined, {
            markerLast: true,
            expectedMarker: `/repo/.git/worktrees/old#${ino}`
          })
        ).rejects.toThrow('A different checkout is now at')
      })

      expect(readFileSync(join(checkoutPath, 'work.txt'), 'utf8')).toBe('unsaved\n')
      expect(readFileSync(join(checkoutPath, '.git'), 'utf8')).toBe(
        'gitdir: /other/.git/worktrees/replaced\n'
      )
    })

    it('removes the checkout when expectedMarker matches', async () => {
      const checkoutPath = join(scratchDir, 'checkout')
      mkdirSync(checkoutPath)
      writeFileSync(join(checkoutPath, '.git'), 'gitdir: /repo/.git/worktrees/accepted\n')
      writeFileSync(join(checkoutPath, 'leftover.txt'), 'stale\n')
      const ino = lstatSync(join(checkoutPath, '.git'), { bigint: true }).ino
      wireGuestShell()

      await withPlatform('win32', async () => {
        await expect(
          removeLocalWorktreePath(checkoutPath, { wslDistro: 'Ubuntu' }, undefined, {
            markerLast: true,
            expectedMarker: `/repo/.git/worktrees/accepted#${ino}`
          })
        ).resolves.toBeUndefined()
      })

      expect(existsSync(checkoutPath)).toBe(false)
    })
  }
)
