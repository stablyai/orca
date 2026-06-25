/**
 * Live-session identity survival across a first-work worktree folder rename.
 *
 * A folder move changes the path-derived worktreeId, but a live PTY's session id
 * is path-stamped and immutable — so ownership must be carried on the runtime
 * record and re-pointed on rename, never re-derived from the id. These tests pin
 * the two runtime guarantees that make that hold:
 *   U1 — notifyWorktreeFolderRenamed re-points every live record old -> new.
 *   U2 — recordPtyWorktree never reverts an existing record's worktreeId (the
 *        periodic controller refresh infers the stale OLD id from the session id).
 */
import { beforeEach, describe, it, expect } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

type PtyRecord = { ptyId: string; worktreeId: string; connected: boolean }

type RuntimeInternals = {
  ptysById: Map<string, PtyRecord>
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean }
  ) => PtyRecord
  migratePtyWorktreeRecords: (oldWorktreeId: string, newWorktreeId: string) => void
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

const OLD = 'repo1::/work/old-creature-name'
const NEW = 'repo1::/work/work-derived-name'
const OTHER = 'repo1::/work/unrelated'

describe('worktree folder rename — live PTY identity', () => {
  let runtime: OrcaRuntimeService
  let i: RuntimeInternals

  beforeEach(() => {
    runtime = new OrcaRuntimeService()
    i = internals(runtime)
  })

  it('re-points every live record from the old worktree id to the new (U1)', () => {
    i.recordPtyWorktree(`${OLD}@@aaaa`, OLD)
    i.recordPtyWorktree(`${OLD}@@bbbb`, OLD)
    i.recordPtyWorktree(`${OTHER}@@cccc`, OTHER)

    runtime.notifyWorktreeFolderRenamed('repo1', OLD, NEW)

    expect(i.ptysById.get(`${OLD}@@aaaa`)?.worktreeId).toBe(NEW)
    expect(i.ptysById.get(`${OLD}@@bbbb`)?.worktreeId).toBe(NEW)
    // An unrelated worktree's record is untouched.
    expect(i.ptysById.get(`${OTHER}@@cccc`)?.worktreeId).toBe(OTHER)
  })

  it('is a no-op when no live record owns the old id (U1)', () => {
    i.recordPtyWorktree(`${OTHER}@@cccc`, OTHER)

    expect(() => runtime.notifyWorktreeFolderRenamed('repo1', OLD, NEW)).not.toThrow()
    expect(i.ptysById.get(`${OTHER}@@cccc`)?.worktreeId).toBe(OTHER)
  })

  it('is a no-op when old equals new (U1)', () => {
    i.recordPtyWorktree(`${OLD}@@aaaa`, OLD)

    i.migratePtyWorktreeRecords(OLD, OLD)

    expect(i.ptysById.get(`${OLD}@@aaaa`)?.worktreeId).toBe(OLD)
  })

  it('does not let a controller refresh revert a re-pointed record (U2)', () => {
    const ptyId = `${OLD}@@aaaa`
    i.recordPtyWorktree(ptyId, OLD)
    runtime.notifyWorktreeFolderRenamed('repo1', OLD, NEW)
    expect(i.ptysById.get(ptyId)?.worktreeId).toBe(NEW)

    // The periodic refresh re-derives the OLD id from the path-stamped session id
    // and calls recordPtyWorktree with it — ownership must NOT revert, but other
    // fields (connected) still update.
    i.recordPtyWorktree(ptyId, OLD, { connected: false })

    expect(i.ptysById.get(ptyId)?.worktreeId).toBe(NEW)
    expect(i.ptysById.get(ptyId)?.connected).toBe(false)
  })

  it('sets worktreeId on first insert (U2)', () => {
    const record = i.recordPtyWorktree(`${OLD}@@aaaa`, OLD)
    expect(record.worktreeId).toBe(OLD)
  })
})
