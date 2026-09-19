import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Repo } from '../shared/repo-types'

const REPO: Repo = { id: 'r', path: '/repo', displayName: 'r', badgeColor: '#000', addedAt: 0 }

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Run a hook past its deadline and report which of its real processes survived. */
async function survivorsAfterDeadline(
  script: string
): Promise<{ shell: boolean; child: boolean; output: string; pids: number[] }> {
  const { runHook } = await import('./hooks')
  const dir = mkdtempSync(join(tmpdir(), 'orca-term-'))
  const pidFile = join(dir, 'pids')
  writeFileSync(
    join(dir, 'orca.yaml'),
    `scripts:\n  archive: |\n${script.replace(/^/gm, '    ')}\n`
  )
  let pids: number[] = []
  try {
    const result = await runHook('archive', dir, REPO, dir, undefined, 400)
    expect(result.success).toBe(false)
    // SIGTERM lands at the deadline, SIGKILL two seconds later.
    await new Promise((resolve) => setTimeout(resolve, 3_500))
    expect(existsSync(pidFile)).toBe(true)
    pids = readFileSync(pidFile, 'utf8').trim().split(/\s+/).map(Number)
    // Without this, a script that recorded only the shell leaves `pids[1]` undefined, `alive`
    // throws, and the missing descendant reads as dead — a test that passes on nothing.
    expect(pids).toHaveLength(2)
    expect(pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)).toBe(true)
    return { shell: alive(pids[0]!), child: alive(pids[1]!), output: result.output, pids }
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

// NO `process.kill` mock, deliberately. The defect this file exists for — `exec` silently ignoring
// `detached`, so the shell was never a group leader and the group signal reached nothing — is
// invisible to a mocked `process.kill`, because the mock makes the signal-0 probe succeed whether
// or not a real group exists. That is the precise condition the bug turns on.
describe.skipIf(process.platform === 'win32')('hook termination against real processes', () => {
  it('kills the shell and its child when the deadline expires', async () => {
    const { shell, child, output } = await survivorsAfterDeadline(
      'echo "archive step 3 of 7"\nsleep 120 &\necho "$$ $!" > "$PWD/pids"\nwait'
    )
    expect({ shell, child }).toEqual({ shell: false, child: false })
    // The gate reports this run as `unverifiable`; what the hook printed is the only clue why.
    expect(output).toContain('archive step 3 of 7')
  }, 30_000)

  it('kills a descendant that ignores SIGTERM', async () => {
    // Only the group SIGKILL can end this one; a SIGTERM to the shell alone leaves it running.
    const { child } = await survivorsAfterDeadline(
      '(trap "" TERM; sleep 120) &\necho "$$ $!" > "$PWD/pids"\nwait'
    )
    expect(child).toBe(false)
  }, 30_000)
})
