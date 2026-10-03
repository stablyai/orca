import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  describeConflictingAppInstances,
  findConflictingAppInstancePids,
  parseRunningApplicationPids,
  runningApplicationQueryOutput
} from './updater-conflicting-app-instances'

const APP_EXECUTABLE = '/Applications/Orca.app/Contents/MacOS/Orca'

function darwinDeps(overrides: Parameters<typeof findConflictingAppInstancePids>[0] = {}) {
  return {
    platform: 'darwin' as NodeJS.Platform,
    executablePath: APP_EXECUTABLE,
    currentPid: 100,
    ...overrides
  }
}

describe('parseRunningApplicationPids', () => {
  it('keeps pids and drops the querying process', () => {
    expect(parseRunningApplicationPids('270\n100\n811\n', 100)).toEqual([270, 811])
  })

  it('ignores blank and non-numeric lines', () => {
    expect(parseRunningApplicationPids('\n270\nnot-a-pid\n  \n', 100)).toEqual([270])
  })
})

describe('findConflictingAppInstancePids', () => {
  it('reports other instances of this same executable', async () => {
    const read = vi.fn().mockResolvedValue('270\n811\n')

    expect(
      await findConflictingAppInstancePids(darwinDeps({ readRunningApplicationPids: read }))
    ).toEqual([270, 811])
    expect(read).toHaveBeenCalledWith(APP_EXECUTABLE, 100)
  })

  it('reports nothing when this is the only instance', async () => {
    const read = vi.fn().mockResolvedValue('')

    expect(
      await findConflictingAppInstancePids(darwinDeps({ readRunningApplicationPids: read }))
    ).toEqual([])
  })

  it('fails open when the query throws', async () => {
    const read = vi.fn().mockRejectedValue(new Error('osascript unavailable'))

    expect(
      await findConflictingAppInstancePids(darwinDeps({ readRunningApplicationPids: read }))
    ).toEqual([])
  })

  it('does not query off darwin, where the installers manage running instances', async () => {
    const read = vi.fn().mockResolvedValue('270\n')

    for (const platform of ['win32', 'linux'] as const) {
      expect(
        await findConflictingAppInstancePids(
          darwinDeps({ platform, readRunningApplicationPids: read })
        )
      ).toEqual([])
    }
    expect(read).not.toHaveBeenCalled()
  })
})

describe('runningApplicationQueryOutput', () => {
  // Fail-open is the property that keeps a broken probe from blocking updates,
  // and the runner reports these as data rather than throwing — so each one is a
  // path that would otherwise look like a successful "no blockers" answer, or
  // worse, like a partial list of them.
  it('passes through the output of a query that exited cleanly', () => {
    expect(runningApplicationQueryOutput({ timedOut: false, code: 0, stdout: '270\n' })).toBe(
      '270\n'
    )
  })

  it('discards partial output from a timed-out query', () => {
    expect(runningApplicationQueryOutput({ timedOut: true, code: null, stdout: '270\n' })).toBe('')
  })

  it('discards output from a query that exited non-zero', () => {
    expect(runningApplicationQueryOutput({ timedOut: false, code: 1, stdout: '270\n' })).toBe('')
  })

  it('discards output from a query killed by a signal', () => {
    expect(runningApplicationQueryOutput({ timedOut: false, code: null, stdout: '270\n' })).toBe('')
  })

  it('discards a clipped list even though the query exited cleanly', () => {
    // The only partial answer that arrives with code 0: the bounded sink hit
    // maxOutputBytes. A truncated pid list would name some blockers and hide
    // others, so it is not an answer this probe may act on.
    expect(
      runningApplicationQueryOutput({
        timedOut: false,
        code: 0,
        stdout: '270\n811\n',
        outputTruncated: true
      })
    ).toBe('')
  })

  it('accepts output that the sink explicitly did not clip', () => {
    expect(
      runningApplicationQueryOutput({
        timedOut: false,
        code: 0,
        stdout: '270\n',
        outputTruncated: false
      })
    ).toBe('270\n')
  })
})

describe('describeConflictingAppInstances', () => {
  it('does not promise a retry the card has no button for', () => {
    // A non-retryable error leaves no primary action, and Settings shows
    // "Restart to Update" only for a downloaded state — so there is nothing to
    // try again from once the other copy is quit.
    expect(describeConflictingAppInstances([270])).not.toContain('try again')
  })

  it('names a single blocking pid, and reads as singular throughout', () => {
    expect(describeConflictingAppInstances([270])).toBe(
      'Another copy of Orca is running (PID 270). macOS cannot replace the app while it is open — quit it.'
    )
  })

  it('reads as plural for more than one', () => {
    expect(describeConflictingAppInstances([270, 811])).toBe(
      '2 other copies of Orca are running (PIDs 270, 811). macOS cannot replace the app while they are open — quit them.'
    )
  })

  it('caps how many pids it lists', () => {
    expect(describeConflictingAppInstances([1, 2, 3, 4, 5, 6])).toContain(
      '6 other copies of Orca are running (PIDs 1, 2, 3, 4, 5, …)'
    )
  })
})

// Why this is a source assertion and not a behavioural one: the behaviour under
// test lives inside the AppKit query, so any test that injects a pid reader
// bypasses exactly the logic that must not regress.
describe('conflicting-instance detection strategy', () => {
  const source = readFileSync(
    path.join(import.meta.dirname, 'updater-conflicting-app-instances.ts'),
    'utf8'
  )
  // Why the query and not the file: the prose above it names AppKit and
  // bundleIdentifier too, so asserting on the file passes even after the query
  // has been rewritten to scan the process table — measured, that is exactly
  // what an earlier version of this ratchet did.
  const query = source.match(/String\.raw`([\s\S]*?)`/)?.[1] ?? ''
  /** The condition deciding which running applications count as blockers. */
  const blockerCondition = query.match(/if\s*\(([\s\S]*?)\)\s*\{/)?.[1] ?? ''

  it('enumerates candidates through LaunchServices, which is what omits the CLI', () => {
    // THIS is the assertion that keeps Orca CLI processes out of the blocker set.
    // The CLI runs from the same bundle executable under ELECTRON_RUN_AS_NODE, so
    // a `ps`-style scan on the executable path would report every CLI invocation
    // as a blocker and refuse updates on any machine that uses the CLI. Such a
    // process never registers with LaunchServices, so `runningApplications` does
    // not list it at all — the omission is in the enumeration, not in any filter.
    // Measured 2026-09-07: `ps` found 4 processes on this bundle executable and
    // this query returned 1.
    expect(query).not.toBe('')
    expect(query).toContain('NSWorkspace.sharedWorkspace.runningApplications')
  })

  it('still requires a bundle identity, as defence in depth rather than the filter', () => {
    // Deliberately NOT described as the CLI exclusion: the same measurement found
    // 0 of 93 running applications with a null bundleIdentifier, and a variant
    // with this clause removed returned the identical single pid. It filters
    // nothing observed today. It stays because NSRunningApplication.bundleIdentifier
    // is documented nil-able and an unbundled process is not one Squirrel waits
    // for — so removing it would widen the set on a machine we have not measured.
    expect(blockerCondition).not.toBe('')
    // Order- and whitespace-independent, so reformatting cannot redden these.
    expect(blockerCondition).toContain('bundleIdentifier')
    expect(blockerCondition).toContain('executableUrl')
    expect(blockerCondition).toContain('executablePath')
  })

  it('never enumerates blockers from the process table', () => {
    // Why the query and not the file: an earlier version matched only a quoted
    // `/bin/ps`, so a bare `/bin/ps -A` at line start sailed through it.
    expect(query).not.toMatch(/\/bin\/ps\b/)
    expect(query).not.toMatch(/\bpgrep\b/)
    expect(query).not.toMatch(/\bNSProcessInfo\b/)
  })

  it('spawns through the shared runner, not node:child_process', () => {
    // The tree-level guard in src/shared/child-process owns this rule; asserting
    // it here too keeps the reason next to the code that has to obey it.
    expect(source).not.toContain('node:child_process')
    expect(source).toContain("from '../shared/child-process/run-process'")
  })
})
