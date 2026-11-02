import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectDescendantRows } from '../pty-descendant-termination'
import { excludeShellBackgroundJobs } from '../pty-shell-job-preservation'
import { markPtyRootAnchored, unmarkPtyRootAnchored } from './anchored-pty-roots'
import { forceKillPosixPtyProcessGroups } from './posix-pty-process-groups'

const startedAt = 'Sun Nov  1 10:00:00 2026'
const row = (pid: number, ppid: number, pgid: number, tpgid = 0) => ({
  pid,
  ppid,
  pgid,
  tpgid,
  startedAt
})
const ROOT = 100
const ANCHOR = 101
const LOGIN = 102
const SHELL = 103
const JOB = 104
const table = [
  row(ROOT, 1, ROOT),
  row(ANCHOR, ROOT, ROOT),
  row(LOGIN, ANCHOR, LOGIN),
  row(SHELL, LOGIN, SHELL, SHELL),
  row(JOB, SHELL, JOB, SHELL)
]

afterEach(() => unmarkPtyRootAnchored(ROOT))

describe('the descendant sweep on an anchored terminal', () => {
  it('walks through the anchor without ever listing it as a target', () => {
    markPtyRootAnchored(ROOT)
    const snapshot = collectDescendantRows(ROOT, table)
    expect(snapshot.anchorPid).toBe(ANCHOR)
    expect(snapshot.descendants.map(({ pid }) => pid)).toEqual([LOGIN, SHELL, JOB])
  })

  it('treats the same tree as ordinary when the root is not anchored', () => {
    const snapshot = collectDescendantRows(ROOT, table)
    expect(snapshot.anchorPid).toBeUndefined()
    expect(snapshot.descendants.map(({ pid }) => pid)).toEqual([ANCHOR, LOGIN, SHELL, JOB])
  })

  it('still lets SIGHUP decide the shell jobs under login', () => {
    markPtyRootAnchored(ROOT)
    const kept = excludeShellBackgroundJobs(collectDescendantRows(ROOT, table), true)
    expect(kept.descendants.map(({ pid }) => pid)).toEqual([LOGIN, SHELL])
  })

  it('still lets SIGHUP decide the jobs of a shell spawned directly', () => {
    markPtyRootAnchored(ROOT)
    const direct = [
      row(ROOT, 1, ROOT),
      row(ANCHOR, ROOT, ROOT),
      row(SHELL, ANCHOR, SHELL, SHELL),
      row(JOB, SHELL, JOB, SHELL)
    ]
    const kept = excludeShellBackgroundJobs(collectDescendantRows(ROOT, direct), false)
    expect(kept.descendants.map(({ pid }) => pid)).toEqual([SHELL])
  })
})

describe('the forced group kill on an anchored terminal', () => {
  const psTable = [
    `${ROOT} ${ROOT} ttys001 Ss`,
    `${ANCHOR} ${ROOT} ttys001 S`,
    `${LOGIN} ${LOGIN} ttys001 S`,
    `${SHELL} ${SHELL} ttys001 S+`,
    `${JOB} ${JOB} ttys001 S`
  ].join('\n')
  const options = (signalProcessGroup: (pgid: number) => void) => ({
    platform: 'darwin' as const,
    currentPid: 999,
    readProcessTable: async () => psTable,
    signalProcessGroup
  })

  it('signals every group except the one holding the anchor, and the root by pid', async () => {
    markPtyRootAnchored(ROOT)
    const signalled: number[] = []
    const killRoot = vi.fn()
    await forceKillPosixPtyProcessGroups(
      ROOT,
      killRoot,
      options((pgid) => signalled.push(pgid))
    )
    expect(signalled).not.toContain(ROOT)
    expect(signalled.sort()).toEqual([LOGIN, SHELL, JOB].sort())
    expect(killRoot).toHaveBeenCalledOnce()
  })

  it('signals the root group as always when the root is not anchored', async () => {
    const signalled: number[] = []
    const killRoot = vi.fn()
    await forceKillPosixPtyProcessGroups(
      ROOT,
      killRoot,
      options((pgid) => signalled.push(pgid))
    )
    expect(signalled.at(-1)).toBe(ROOT)
    expect(killRoot).not.toHaveBeenCalled()
  })
})
