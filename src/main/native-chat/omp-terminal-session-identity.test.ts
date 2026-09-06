import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  encodeOmpSessionCwdBucket,
  parseOmpSessionIdFromFilename,
  resolveOmpPaneSessionIdentity,
  terminalIdFromSlavePath
} from './omp-terminal-session-identity'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

describe('terminalIdFromSlavePath', () => {
  it('takes the basename of a posix slave device path', () => {
    expect(terminalIdFromSlavePath('/dev/ttys021')).toBe('ttys021')
  })

  it('returns null for an empty path', () => {
    expect(terminalIdFromSlavePath('')).toBeNull()
  })
})

describe('parseOmpSessionIdFromFilename', () => {
  it('splits at the first underscore after the timestamp', () => {
    expect(
      parseOmpSessionIdFromFilename(
        '/root/-dev-orca/2026-08-12T00-30-36-053Z_019ff360-d015-7000-b307-561e7306dc73.jsonl'
      )
    ).toBe('019ff360-d015-7000-b307-561e7306dc73')
  })

  it('returns null when there is no underscore delimiter', () => {
    expect(parseOmpSessionIdFromFilename('/root/-dev-orca/nodelimiter.jsonl')).toBeNull()
  })
})

describe('encodeOmpSessionCwdBucket', () => {
  it('encodes a home-relative cwd with a single leading dash', () => {
    const bucket = encodeOmpSessionCwdBucket('/Users/ada/dev/projects/orca', {
      homeDir: '/Users/ada',
      tempDir: '/tmp'
    })
    expect(bucket).toBe('-dev-projects-orca')
  })

  it('encodes a temp-root cwd with the -tmp- prefix', () => {
    const bucket = encodeOmpSessionCwdBucket('/tmp/scratch/work', {
      homeDir: '/Users/ada',
      tempDir: '/tmp'
    })
    expect(bucket).toBe('-tmp-scratch-work')
  })

  it('wraps an otherwise-unrelated absolute cwd in double dashes', () => {
    const bucket = encodeOmpSessionCwdBucket('/opt/foo/bar', {
      homeDir: '/Users/ada',
      tempDir: '/tmp'
    })
    expect(bucket).toBe('--opt-foo-bar--')
  })
})

describe('resolveOmpPaneSessionIdentity', () => {
  it('resolves via a materialized breadcrumb whose cwd matches the pane', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-breadcrumb-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const sessionFile = join(bucketDir, '2026-08-12T00-30-36-053Z_session-a.jsonl')
    await writeFile(sessionFile, '{}\n')
    await mkdir(join(root, 'terminal-sessions'), { recursive: true })
    await writeFile(join(root, 'terminal-sessions', 'ttys000'), `${cwd}\n${sessionFile}\n`)

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => '/dev/ttys000'
      }
    )

    expect(resolved).toEqual({
      sessionId: 'session-a',
      sessionFilePath: sessionFile,
      source: 'breadcrumb'
    })
  })

  it('refuses a live PTY when its breadcrumb is stale', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-stale-breadcrumb-')
    const cwd = join(root, 'work')
    const otherCwd = join(root, 'other')
    await mkdir(cwd, { recursive: true })
    await mkdir(otherCwd, { recursive: true })
    const staleSessionFile = join(root, 'sessions', '-other', 'stale.jsonl')
    await mkdir(join(root, 'sessions', '-other'), { recursive: true })
    await writeFile(staleSessionFile, '{}\n')
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const realSessionFile = join(bucketDir, '2026-08-12T00-30-36-053Z_session-real.jsonl')
    await writeFile(realSessionFile, '{}\n')
    await mkdir(join(root, 'terminal-sessions'), { recursive: true })
    // Breadcrumb still names the OTHER cwd/session — a leftover from a previous
    // process that used the same tty slot.
    await writeFile(
      join(root, 'terminal-sessions', 'ttys000'),
      `${otherCwd}\n${staleSessionFile}\n`
    )

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => '/dev/ttys000'
      }
    )

    expect(resolved).toBeNull()
  })

  it('returns null (never falls back) for a missing-but-fresh breadcrumb', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-fresh-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    // A prior session exists in the bucket, but the fresh boundary must win —
    // resurrecting it would silently undo the user's own `/new`.
    await writeFile(join(bucketDir, '2026-08-12T00-30-36-053Z_prior.jsonl'), '{}\n')
    await mkdir(join(root, 'terminal-sessions'), { recursive: true })
    await writeFile(join(root, 'terminal-sessions', 'ttys000'), `${cwd}\n\nfresh\n`)

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => '/dev/ttys000'
      }
    )

    expect(resolved).toBeNull()
  })

  it('refuses a live PTY without a slave path instead of guessing by session-file mtime', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-mtime-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const older = join(bucketDir, '2026-08-11T00-00-00-000Z_older.jsonl')
    const newer = join(bucketDir, '2026-08-12T00-00-00-000Z_newer.jsonl')
    await writeFile(older, '{}\n')
    await writeFile(newer, '{}\n')
    // Why explicit utimes instead of a real sleep: mtime ordering is the
    // behavior under test, so set it deterministically rather than racing
    // the filesystem clock's resolution.
    await utimes(older, new Date('2026-08-11T00:00:00Z'), new Date('2026-08-11T00:00:00Z'))
    await utimes(newer, new Date('2026-08-12T00:00:00Z'), new Date('2026-08-12T00:00:00Z'))

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => undefined
      }
    )

    expect(resolved).toBeNull()
  })

  it('returns null when nothing exists in the bucket (never invents a path)', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-empty-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => undefined
      }
    )

    expect(resolved).toBeNull()
  })

  it('uses mtime fallback only when no PTY remains to identify', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-no-tty-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const target = join(bucketDir, '2026-08-12T00-00-00-000Z_only.jsonl')
    await writeFile(target, '{}\n')

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: null, cwd },
      { agentDir: root, homeDir: root, tempDir: join(root, 'no-tmp'), getSlavePath: undefined }
    )

    expect(resolved).toEqual({
      sessionId: 'only',
      sessionFilePath: target,
      source: 'mtime-fallback'
    })
  })

  it('skips a newer file whose name carries no session id and resumes the older valid one', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-unparsable-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const valid = join(bucketDir, '2026-08-12T00-00-00-000Z_older.jsonl')
    await writeFile(valid, '{}\n')
    await utimes(valid, new Date('2026-08-12T00:00:00Z'), new Date('2026-08-12T00:00:00Z'))
    const unparsable = join(bucketDir, 'scratch.jsonl')
    await writeFile(unparsable, '{}\n')
    await utimes(unparsable, new Date('2026-08-13T00:00:00Z'), new Date('2026-08-13T00:00:00Z'))

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: null, cwd },
      { agentDir: root, homeDir: root, tempDir: join(root, 'no-tmp'), getSlavePath: undefined }
    )

    expect(resolved).toEqual({
      sessionId: 'older',
      sessionFilePath: valid,
      source: 'mtime-fallback'
    })
  })

  it('parses the bare session id from a Windows path with underscores in parent directories', () => {
    expect(
      parseOmpSessionIdFromFilename(
        'C:\\work_tree\\sessions\\-work\\2026-08-12T00-00-00-000Z_session-a.jsonl'
      )
    ).toBe('session-a')
    expect(parseOmpSessionIdFromFilename('/a_b/c/2026-08-12T00-00-00-000Z_x.jsonl')).toBe('x')
  })

  // Finding D (cross-lab review, wave 5): a breadcrumb's recorded cwd and
  // the pane's actual cwd are normalized (realpath + trailing-slash strip)
  // before comparison, so a symlinked worktree or a trailing slash no
  // longer reads as a stale-tty mismatch on its own.
  it.skipIf(process.platform === 'win32')(
    'resolves via a breadcrumb whose recorded cwd differs from the pane only by symlink resolution (finding D)',
    async () => {
      const root = await makeRoot('orca-omp-terminal-identity-symlink-')
      const realDir = join(root, 'real')
      await mkdir(realDir, { recursive: true })
      const linkedDir = join(root, 'linked')
      await symlink(realDir, linkedDir, 'dir')
      const sessionFile = join(root, 'sessions', '2026-08-12T00-30-36-053Z_session-a.jsonl')
      await mkdir(join(root, 'sessions'), { recursive: true })
      await writeFile(sessionFile, '{}\n')
      await mkdir(join(root, 'terminal-sessions'), { recursive: true })
      // Breadcrumb recorded the cwd through the symlink; the pane now reports
      // the same directory resolved to its real path — same directory,
      // different string.
      await writeFile(join(root, 'terminal-sessions', 'ttys000'), `${linkedDir}\n${sessionFile}\n`)

      const resolved = await resolveOmpPaneSessionIdentity(
        { ptyId: 'pty-1', cwd: realDir },
        {
          agentDir: root,
          homeDir: root,
          tempDir: join(root, 'no-tmp'),
          getSlavePath: () => '/dev/ttys000'
        }
      )

      expect(resolved).toEqual({
        sessionId: 'session-a',
        sessionFilePath: sessionFile,
        source: 'breadcrumb'
      })
    }
  )

  it('resolves via a breadcrumb whose recorded cwd differs from the pane only by a trailing slash (finding D)', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-trailing-slash-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const sessionFile = join(root, 'sessions', '2026-08-12T00-30-36-053Z_session-a.jsonl')
    await mkdir(join(root, 'sessions'), { recursive: true })
    await writeFile(sessionFile, '{}\n')
    await mkdir(join(root, 'terminal-sessions'), { recursive: true })
    await writeFile(join(root, 'terminal-sessions', 'ttys000'), `${cwd}/\n${sessionFile}\n`)

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => '/dev/ttys000'
      }
    )

    expect(resolved).toEqual({
      sessionId: 'session-a',
      sessionFilePath: sessionFile,
      source: 'breadcrumb'
    })
  })

  // Finding C (cross-lab review, wave 5): a session another live pane
  // already claimed must never be offered to a second pane sharing the
  // same cwd bucket via the mtime-fallback heuristic.
  it('excludes a session another RPC pane claimed from a safe mtime fallback', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-claimed-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const older = join(bucketDir, '2026-08-11T00-00-00-000Z_older.jsonl')
    const newer = join(bucketDir, '2026-08-12T00-00-00-000Z_newer.jsonl')
    await writeFile(older, '{}\n')
    await writeFile(newer, '{}\n')
    await utimes(older, new Date('2026-08-11T00:00:00Z'), new Date('2026-08-11T00:00:00Z'))
    await utimes(newer, new Date('2026-08-12T00:00:00Z'), new Date('2026-08-12T00:00:00Z'))

    // Without exclusion, `newer` would win (see the plain mtime-fallback
    // test above) — but another pane already claimed it, so the fallback
    // must skip to the next-newest unclaimed candidate instead.
    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: null, cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => undefined,
        claimedSessionFilePaths: new Set([newer])
      }
    )

    expect(resolved).toEqual({
      sessionId: 'older',
      sessionFilePath: older,
      source: 'mtime-fallback'
    })
  })

  it('returns null when every candidate in the bucket is already claimed', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-all-claimed-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const only = join(bucketDir, '2026-08-12T00-00-00-000Z_only.jsonl')
    await writeFile(only, '{}\n')

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: 'pty-1', cwd },
      {
        agentDir: root,
        homeDir: root,
        tempDir: join(root, 'no-tmp'),
        getSlavePath: () => undefined,
        claimedSessionFilePaths: new Set([only])
      }
    )

    expect(resolved).toBeNull()
  })

  // Wave 9, Defect 1, acceptance criterion 2: `ptyId` is an optional
  // accuracy input — a null value must resolve via the mtime fallback
  // exactly like a ptyId whose terminal id cannot be determined, never
  // fail closed just because no PTY is live.
  it('resolves via the mtime fallback when ptyId is null', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-null-pty-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const target = join(bucketDir, '2026-08-12T00-00-00-000Z_only.jsonl')
    await writeFile(target, '{}\n')

    const resolved = await resolveOmpPaneSessionIdentity(
      { ptyId: null, cwd },
      { agentDir: root, homeDir: root, tempDir: join(root, 'no-tmp'), getSlavePath: undefined }
    )

    expect(resolved).toEqual({
      sessionId: 'only',
      sessionFilePath: target,
      source: 'mtime-fallback'
    })
  })

  it('resolves a live pane via the mtime fallback when its PTY has no slave path', async () => {
    const root = await makeRoot('orca-omp-terminal-identity-unknown-slave-')
    const cwd = join(root, 'work')
    await mkdir(cwd, { recursive: true })
    const bucketDir = join(root, 'sessions', '-work')
    await mkdir(bucketDir, { recursive: true })
    const target = join(bucketDir, '2026-08-12T00-00-00-000Z_conpty.jsonl')
    await writeFile(target, '{}\n')

    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    let resolved
    try {
      resolved = await resolveOmpPaneSessionIdentity(
        { ptyId: 'pty-1', cwd },
        { agentDir: root, homeDir: root, tempDir: join(root, 'no-tmp'), getSlavePath: () => undefined }
      )
    } finally {
      Object.defineProperty(process, 'platform', { value: platform })
    }

    expect(resolved).toEqual({
      sessionId: 'conpty',
      sessionFilePath: target,
      source: 'mtime-fallback'
    })
  })
})
