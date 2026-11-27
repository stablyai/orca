import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import type * as FileSystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Exercise Windows filename folding through source listings on case-sensitive hosts.
vi.mock('./command-path-directory-worker-client', async () => ({
  readDetectionDirectoryViaWorker: vi.fn(
    (await import('./command-path-directory')).readDetectionDirectory
  )
}))
const filesystem = vi.hoisted((): { realStat?: typeof FileSystem.stat } => ({}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>()
  filesystem.realStat = fs.stat
  return { ...fs, stat: vi.fn(fs.stat) }
})
import { readDetectionDirectoryViaWorker } from './command-path-directory-worker-client'
import { readDetectionDirectory } from './command-path-directory'
import { findCommandsOnLocalPath, type AgentPathMatch } from './command-path-batch'
import { isCommandOnLocalPath, resolveCommandOnLocalPath } from './command-path-resolver'
import { resolveCmdLaunchFolderProgram } from './cmd-launch-folder-program'

describe('isCommandOnLocalPath', () => {
  // POSIX semantics: executable bit + absolute-only + symlink follow.
  describe.skipIf(process.platform === 'win32')('posix', () => {
    let dir = ''
    beforeAll(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'cmd-resolver-posix-'))
      await writeFile(path.join(dir, 'runme'), '#!/bin/sh\n')
      await chmod(path.join(dir, 'runme'), 0o755)
      await writeFile(path.join(dir, 'plain'), 'not executable\n')
      await chmod(path.join(dir, 'plain'), 0o644)
      await mkdir(path.join(dir, 'adir'))
      await symlink(path.join(dir, 'runme'), path.join(dir, 'linkme'))
    })
    afterAll(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('rejects a non-executable file on PATH', async () => {
      await expect(
        isCommandOnLocalPath('plain', { platform: 'linux', env: { PATH: dir } })
      ).resolves.toBe(false)
    })

    it('rejects a directory whose name matches the command', async () => {
      await expect(
        isCommandOnLocalPath('adir', { platform: 'linux', env: { PATH: dir } })
      ).resolves.toBe(false)
    })

    it('rejects a match reached via a relative PATH entry (absolute-only gate)', async () => {
      await expect(
        isCommandOnLocalPath('runme', { platform: 'linux', env: { PATH: '.' }, cwd: dir })
      ).resolves.toBe(false)
    })

    it.skipIf(process.platform !== 'linux')(
      'does not satisfy codex with Codex on PATH',
      async () => {
        const file = path.join(dir, 'Codex')
        await writeFile(file, '#!/bin/sh\n')
        await chmod(file, 0o755)
        await expect(
          findCommandsOnLocalPath(['codex', 'absent-a', 'absent-b', 'absent-c', 'absent-d'], {
            env: { PATH: dir }
          })
        ).resolves.toEqual(new Set())
      }
    )
  })
})

describe('win32 PATH lookup', () => {
  let root = ''
  let emptyCwd = ''
  let quotedBin = ''
  let dotBin = ''
  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'cmd-resolver-win32-'))
    emptyCwd = path.join(root, 'empty-cwd')
    quotedBin = path.join(root, 'bin with spaces')
    dotBin = path.join(root, 'node_modules', '.bin')
    await Promise.all([
      mkdir(emptyCwd, { recursive: true }),
      mkdir(quotedBin, { recursive: true }),
      mkdir(dotBin, { recursive: true })
    ])
    await Promise.all([
      writeFile(path.join(quotedBin, 'tool'), '#!/bin/sh\n'),
      writeFile(path.join(quotedBin, 'tool.cmd'), '@echo off\r\n'),
      writeFile(path.join(dotBin, 'tool.cmd'), '@echo off\r\n'),
      writeFile(path.join(quotedBin, 'format.v1'), '#!/bin/sh\n'),
      writeFile(path.join(quotedBin, 'format.v1.cmd'), '@echo off\r\n'),
      writeFile(path.join(dotBin, 'prettier'), '#!/bin/sh\n'),
      writeFile(path.join(dotBin, 'prettier.cmd'), '@echo off\r\n')
    ])
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('lets a live cmd retry continue after a shared stat misses', async () => {
    const exe = path.join(quotedBin, 'retry-tool.EXE')
    const cmd = path.join(quotedBin, 'retry-tool.CMD')
    await writeFile(cmd, '@echo off\r\n')
    const held = Promise.withResolvers<Awaited<ReturnType<typeof stat>>>()
    const statFile = vi.mocked(stat)
    statFile.mockClear()
    statFile.mockImplementationOnce(() => held.promise)
    const firstCaller = new AbortController()
    const retryCaller = new AbortController()
    const lookup = (signal: AbortSignal) =>
      resolveCmdLaunchFolderProgram('retry-tool', quotedBin, '.EXE;.CMD', signal)
    const first = lookup(firstCaller.signal).catch((error: unknown) => error)
    try {
      firstCaller.abort()
      expect(await first).toMatchObject({ name: 'AbortError' })
      const retry = lookup(retryCaller.signal)
      expect(statFile.mock.calls).toEqual([[exe]])
      held.reject(new Error('Missing executable'))
      await expect(retry).resolves.toBe(cmd)
      expect(statFile.mock.calls).toEqual([[exe], [cmd]])
      await expect(lookup(new AbortController().signal)).resolves.toBe(cmd)
      expect(statFile.mock.calls).toEqual([[exe], [cmd], [exe], [cmd]])
    } finally {
      held.reject(new Error('Missing executable'))
      statFile.mockReset()
    }
  })

  it('rechecks settled cmd candidates and shares pending stats across staggered callers', async () => {
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const [exe, cmd, bat, com] = ['EXE', 'CMD', 'BAT', 'COM'].map((ext) =>
      path.join(quotedBin, `staggered-tool.${ext}`)
    )
    const statFile = vi.mocked(stat)
    statFile.mockClear()
    statFile.mockImplementation(async (file) => {
      if (file === bat) {
        entered.resolve()
        await held.promise
      }
      throw new Error('Missing executable')
    })
    const lookup = () =>
      resolveCmdLaunchFolderProgram(
        'staggered-tool',
        quotedBin,
        '.EXE;.CMD;.BAT;.COM',
        new AbortController().signal
      )
    try {
      const first = lookup()
      await expect(Promise.race([entered.promise, first])).resolves.toBeUndefined()
      const second = lookup()
      // Let the second caller finish its immediate misses and reach the stalled stat.
      await new Promise<void>((resolve) => setImmediate(resolve))
      held.resolve()
      await expect(Promise.all([first, second])).resolves.toEqual([null, null])
      expect(statFile.mock.calls).toEqual([[exe], [cmd], [bat], [exe], [cmd], [com]])
    } finally {
      held.resolve()
      statFile.mockReset()
    }
  })

  it('stats cmd launch folders separately when their paths differ only by case', async () => {
    const held = Promise.withResolvers<Awaited<ReturnType<typeof stat>>>()
    const statFile = vi.mocked(stat)
    statFile.mockClear()
    statFile.mockImplementation(() => held.promise)
    const signal = new AbortController().signal
    try {
      const lower = resolveCmdLaunchFolderProgram('claude', 'C:/case/repo', '.EXE', signal)
      const upper = resolveCmdLaunchFolderProgram('claude', 'C:/case/Repo', '.EXE', signal)
      held.reject(new Error('Missing executable'))
      await Promise.all([lower, upper])
      expect(statFile.mock.calls).toEqual([
        [path.join('C:/case/repo', 'claude.EXE')],
        [path.join('C:/case/Repo', 'claude.EXE')]
      ])
    } finally {
      statFile.mockReset()
    }
  })

  it('finds a cmd shim created after an expired caller missed it', async () => {
    const cmd = path.join(quotedBin, 'late-shim.CMD')
    const bat = path.join(quotedBin, 'late-shim.BAT')
    const entered = Promise.withResolvers<void>()
    const held = Promise.withResolvers<void>()
    const statFile = vi.mocked(stat)
    statFile.mockImplementation(async (file) => {
      if (file === bat) {
        entered.resolve()
        await held.promise
        throw new Error('Missing executable')
      }
      return filesystem.realStat!(file)
    })
    const lookup = (signal: AbortSignal) =>
      resolveCmdLaunchFolderProgram('late-shim', quotedBin, '.EXE;.CMD;.BAT;.COM', signal)
    const caller = new AbortController()
    const first = lookup(caller.signal).catch((error: unknown) => error)
    try {
      await expect(Promise.race([entered.promise, first])).resolves.toBeUndefined()
      caller.abort()
      expect(await first).toMatchObject({ name: 'AbortError' })
      await writeFile(cmd, '@echo off\r\n')
      const second = lookup(new AbortController().signal)
      held.resolve()
      await expect(second).resolves.toBe(cmd)
    } finally {
      caller.abort()
      held.resolve()
      statFile.mockReset()
    }
  })

  it('resolves commands from quoted Windows PATH entries in single and batch lookups', async () => {
    const options = {
      platform: 'win32' as const,
      cwd: emptyCwd,
      env: { PATH: `"${quotedBin}"`, PATHEXT: '.EXE;.cmd' }
    }
    await expect(resolveCommandOnLocalPath('tool', options)).resolves.toBe(
      path.join(quotedBin, 'tool.cmd')
    )
    await expect(findCommandsOnLocalPath(['tool'], options)).resolves.toEqual(new Set(['tool']))
  })

  it('keeps single quotes in Windows PATH entries literal', async () => {
    const options = {
      platform: 'win32' as const,
      cwd: emptyCwd,
      env: { PATH: `'${quotedBin}'`, PATHEXT: '.EXE;.cmd' }
    }
    await expect(resolveCommandOnLocalPath('tool', options)).resolves.toBeNull()
    await expect(findCommandsOnLocalPath(['tool'], options)).resolves.toEqual(new Set())
  })

  it('selects the first Windows PATH hit when a later stat finishes first', async () => {
    const earlier = path.join(quotedBin, 'tool.cmd')
    const later = path.join(dotBin, 'tool.cmd')
    const earlierStarted = Promise.withResolvers<void>()
    const laterChecked = Promise.withResolvers<void>()
    vi.mocked(stat).mockImplementation(async (candidate) => {
      if (candidate === earlier) {
        earlierStarted.resolve()
        await laterChecked.promise
      }
      if (candidate === later) {
        await earlierStarted.promise
      }
      const result = await filesystem.realStat!(candidate)
      if (candidate === later) {
        setImmediate(laterChecked.resolve)
      }
      return result
    })
    try {
      const matches = new Map<string, string>()
      await findCommandsOnLocalPath(['tool', 'absent-a', 'absent-b', 'absent-c', 'absent-d'], {
        platform: 'win32',
        cwd: '',
        env: { PATH: `"${emptyCwd}";"${quotedBin}";"${dotBin}"`, PATHEXT: '.cmd' },
        matches
      })
      expect(matches.get('tool')).toBe(earlier)
    } finally {
      vi.mocked(stat).mockReset()
    }
  })

  it('stops at a verified quoted PATH hit when CWD is the same directory', async () => {
    const late = path.join(root, 'late')
    const programs = ['claude', 'codex', 'grok', 'omp', 'opencode']
    await Promise.all(
      programs.map((program) => writeFile(path.join(quotedBin, `${program}.cmd`), ''))
    )
    const held = Promise.withResolvers<Map<string, string> | null>()
    const listings = vi.mocked(readDetectionDirectoryViaWorker)
    listings.mockClear()
    listings.mockImplementation((dir) =>
      dir === late ? held.promise : readDetectionDirectory(dir)
    )
    vi.mocked(stat).mockClear()
    const matches = new Map<string, AgentPathMatch>()
    try {
      await expect(
        findCommandsOnLocalPath(programs, {
          platform: 'win32',
          cwd: quotedBin,
          env: { PATH: `"${quotedBin}/";${late}`, PATHEXT: '.cmd' },
          inventory: { isRuntimePath: () => false, matches }
        })
      ).resolves.toEqual(new Set(programs))
      expect(matches.get('claude')).toEqual({
        first: path.join(quotedBin, 'claude.cmd'),
        user: path.join(quotedBin, 'claude.cmd')
      })
      expect(listings.mock.calls).toEqual([[quotedBin, true]])
      expect(
        vi.mocked(stat).mock.calls.filter(([file]) => file === path.join(quotedBin, 'claude.cmd'))
      ).toHaveLength(1)
    } finally {
      held.resolve(new Map())
      listings.mockReset()
    }
  })

  it.each(['PATH', 'CWD'])(
    'finds the user install while retaining shell precedence past a %s shadow',
    async (source) => {
      const runtime = path.join(root, `orca-runtime-${source}`)
      const late = path.join(root, 'late')
      const programs = ['claude', 'codex', 'grok', 'omp', 'opencode']
      const shadowOnPath = source === 'PATH'
      await mkdir(runtime)
      await Promise.all([
        writeFile(path.join(runtime, 'claude.cmd'), ''),
        ...programs.map((program) => writeFile(path.join(dotBin, `${program}.cmd`), ''))
      ])
      const held = Promise.withResolvers<Map<string, string> | null>()
      const listings = vi.mocked(readDetectionDirectoryViaWorker)
      listings.mockClear()
      listings.mockImplementation((dir) =>
        dir === late ? held.promise : readDetectionDirectory(dir)
      )
      vi.mocked(stat).mockClear()
      const matches = new Map<string, AgentPathMatch>()
      try {
        await expect(
          findCommandsOnLocalPath(programs, {
            platform: 'win32',
            cwd: shadowOnPath ? '' : runtime,
            env: {
              PATH: `${shadowOnPath ? `"${runtime}";${runtime};` : ''}${dotBin};${late}`,
              PATHEXT: '.cmd'
            },
            inventory: { isRuntimePath: (dir) => shadowOnPath && dir === runtime, matches }
          })
        ).resolves.toEqual(new Set(programs))
        const user = path.join(dotBin, 'claude.cmd')
        expect(matches.get('claude')).toEqual({
          first: null,
          unquoted: shadowOnPath ? null : user,
          user
        })
        expect(listings.mock.calls.filter(([dir]) => dir === runtime)).toHaveLength(1)
        expect(
          vi.mocked(stat).mock.calls.filter(([file]) => file === path.join(runtime, 'claude.cmd'))
        ).toHaveLength(1)
      } finally {
        held.resolve(new Map())
        listings.mockReset()
      }
    }
  )

  it('ignores dots in parent directories so path-qualified lookups do not match POSIX siblings', async () => {
    const target = path.join(dotBin, 'prettier')
    await expect(
      resolveCommandOnLocalPath(target, {
        platform: 'win32',
        cwd: emptyCwd,
        env: { PATH: '', PATHEXT: '.EXE;.cmd' }
      })
    ).resolves.toBe(`${target}.cmd`)
  })

  it('keeps the exact-name-first match for dotted basenames', async () => {
    await expect(
      resolveCommandOnLocalPath('format.v1', {
        platform: 'win32',
        cwd: emptyCwd,
        env: { PATH: quotedBin, PATHEXT: '.EXE;.cmd' }
      })
    ).resolves.toBe(path.join(quotedBin, 'format.v1'))
  })
})

// An execute-only directory cannot be listed, but stat on known names still works.
describe.skipIf(process.platform === 'win32')(
  'findCommandsOnLocalPath unreadable PATH entry',
  () => {
    let locked = ''
    beforeAll(async () => {
      locked = await mkdtemp(path.join(tmpdir(), 'cmd-batch-locked-'))
      await writeFile(path.join(locked, 'runme'), '#!/bin/sh\n')
      await chmod(path.join(locked, 'runme'), 0o755)
      await chmod(locked, 0o111)
    })
    afterAll(async () => {
      await chmod(locked, 0o755)
      await rm(locked, { recursive: true, force: true })
    })

    it('probes known names directly when directory listing is denied', async ({ skip }) => {
      const error = await readdir(locked).then(
        () => null,
        (error: unknown) => error
      )
      if (error === null) {
        skip()
        return
      }
      expect(error).toMatchObject({ code: 'EACCES' })
      await expect(
        findCommandsOnLocalPath(['runme', 'missing-a', 'missing-b', 'missing-c', 'missing-d'], {
          platform: 'linux',
          env: { PATH: locked }
        })
      ).resolves.toEqual(new Set(['runme']))
    })
  }
)
