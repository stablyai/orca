import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  anyFenceSentinelDenies,
  clearFenceSentinel,
  fenceFileFor,
  fenceKeyFor,
  fenceSentinelDenies,
  FenceSentinelUnavailable,
  serializeFenceSentinel,
  writeFenceSentinel
} from './pretool-fence-sentinel'

const WORKTREE = 'repo_a::/work/jb-workflow-control-plane-b'
const ACQUIRED_AT = '2026-08-28T12:00:00.000Z'

function endpoint(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-sentinel-'))
  mkdirSync(join(dir, 'agent-hooks'), { recursive: true })
  return join(dir, 'agent-hooks', 'endpoint.env')
}

describe('the offline validation fence', () => {
  it('is verified on write, not assumed', () => {
    const path = writeFenceSentinel({
      endpointFilePath: endpoint(),
      worktreeId: WORKTREE,
      leaseId: 'lease_1',
      acquiredAt: ACQUIRED_AT,
      expiresAtMs: Date.now() + 60_000
    })
    expect(readFileSync(path, 'utf8').split('\n')[0]).toBe(WORKTREE)
  })

  it('NEGATIVE CONTROL: a write that cannot land throws instead of reporting success', () => {
    // A lease told "acquired" whose offline half does not exist is worse than a
    // refused one: the caller proceeds believing the tree is guarded.
    const endpointFilePath = endpoint()
    const dir = join(endpointFilePath, '..', 'fence')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o500)
    try {
      expect(() =>
        writeFenceSentinel({
          endpointFilePath,
          worktreeId: WORKTREE,
          leaseId: 'lease_1',
          acquiredAt: ACQUIRED_AT,
          expiresAtMs: Date.now() + 60_000
        })
      ).toThrow(FenceSentinelUnavailable)
    } finally {
      chmodSync(dir, 0o700)
    }
  })

  it('NEGATIVE CONTROL: two colliding workspaces both stay fenced', async () => {
    // The name keeps only the last 64 characters and flattens separators, so two
    // deep checkouts that differ near the root share a prefix. One file per
    // LEASE keeps them from overwriting each other: a single shared filename
    // left whichever was written first silently unfenced offline.
    const suffix = '/workspaces/orca-jb/jb-workflow-control-plane-b/deeply/nested/tree'
    const first = `repo_a::/Users/one${suffix}`
    const second = `repo_b::/Users/two${suffix}`
    expect(fenceKeyFor(second)).toBe(fenceKeyFor(first))

    const endpointFilePath = endpoint()
    const expiresAtMs = Date.now() + 60_000
    // THE SAME lease id on both. Uniqueness must not depend on a caller's
    // choice: two colliding workspaces that pick the same id — or ids that
    // sanitize alike — previously overwrote one marker and left the first
    // workspace silently unfenced.
    const firstPath = writeFenceSentinel({
      endpointFilePath,
      worktreeId: first,
      leaseId: 'lease_same',
      acquiredAt: ACQUIRED_AT,
      expiresAtMs
    })
    const secondPath = writeFenceSentinel({
      endpointFilePath,
      worktreeId: second,
      leaseId: 'lease_same',
      acquiredAt: ACQUIRED_AT,
      expiresAtMs
    })
    expect(firstPath).not.toBe(secondPath)

    const records = [readFileSync(firstPath, 'utf8'), readFileSync(secondPath, 'utf8')]
    // Both are still fenced, and neither answers for the other.
    expect(anyFenceSentinelDenies(records, first, Date.now())).toBe(true)
    expect(anyFenceSentinelDenies(records, second, Date.now())).toBe(true)
    expect(anyFenceSentinelDenies(records, `repo_c::/Users/three${suffix}`, Date.now())).toBe(false)
  })

  it('NEGATIVE CONTROL: the offline expiry never precedes the lease it mirrors', () => {
    // Flooring retired the offline fence up to 999ms early, leaving a window
    // where the row said protected and the only fence a disconnected worker
    // could see said otherwise.
    for (const offsetMs of [1, 499, 500, 999, 1000, 1001]) {
      const expiresAtMs = Date.now() + offsetMs
      const contents = serializeFenceSentinel({
        worktreeId: WORKTREE,
        leaseId: 'lease_1',
        acquiredAt: ACQUIRED_AT,
        expiresAtMs
      })
      const markedSeconds = Number.parseInt(contents.split('\n')[1] as string, 10)
      expect(markedSeconds * 1000).toBeGreaterThanOrEqual(expiresAtMs)
      // And it still denies at every instant the database lease is live.
      expect(fenceSentinelDenies(contents, WORKTREE, expiresAtMs - 1)).toBe(true)
    }
  })

  it('NEGATIVE CONTROL: an expired marker stops denying on its own', () => {
    const contents = serializeFenceSentinel({
      worktreeId: WORKTREE,
      leaseId: 'lease_1',
      acquiredAt: ACQUIRED_AT,
      expiresAtMs: Date.now() - 1_000
    })
    // A marker orphaned by a crash must not wedge the workspace forever.
    expect(fenceSentinelDenies(contents, WORKTREE, Date.now())).toBe(false)
  })

  it('treats an unreadable or truncated marker as no fence rather than a forever fence', () => {
    expect(fenceSentinelDenies(null, WORKTREE, Date.now())).toBe(false)
    expect(fenceSentinelDenies(`${WORKTREE}\n`, WORKTREE, Date.now())).toBe(false)
    expect(fenceSentinelDenies(`${WORKTREE}\nnot-a-number\n`, WORKTREE, Date.now())).toBe(false)
  })

  it('NEGATIVE CONTROL: the expiry parser refuses exactly what the shell refuses', () => {
    // parseInt('99999999999abc') is a number; the shell's `case *[!0-9]*`
    // rejects it. A parser that accepted what the reader refuses would make the
    // two halves disagree about whether a workspace is fenced.
    const shellAccepts = (value: string): boolean =>
      spawnSync('/bin/sh', ['-c', 'case "$1" in \'\'|*[!0-9]*) exit 1 ;; esac', 'sh', value])
        .status === 0
    for (const expiry of ['99999999999abc', ' 99999999999', '1e12', '+5', '-5', '', '12.5', '5x']) {
      expect(fenceSentinelDenies(`${WORKTREE}\n${expiry}\n`, WORKTREE, 0)).toBe(
        shellAccepts(expiry)
      )
    }
    // And a plainly numeric one is accepted by both.
    expect(shellAccepts('99999999999')).toBe(true)
    expect(fenceSentinelDenies(`${WORKTREE}\n99999999999\n`, WORKTREE, 0)).toBe(true)
  })

  it('a rightful release clears it', () => {
    const endpointFilePath = endpoint()
    writeFenceSentinel({
      endpointFilePath,
      worktreeId: WORKTREE,
      leaseId: 'lease_1',
      acquiredAt: ACQUIRED_AT,
      expiresAtMs: Date.now() + 60_000
    })
    expect(
      clearFenceSentinel(endpointFilePath, WORKTREE, {
        leaseId: 'lease_1',
        acquiredAt: ACQUIRED_AT
      })
    ).toBe(true)
    expect(() => readFileSync(fenceFileFor(endpointFilePath, WORKTREE))).toThrow()
  })

  it('NEGATIVE CONTROL: a delayed old release cannot clear a replacement lease marker', () => {
    const endpointFilePath = endpoint()
    writeFenceSentinel({
      endpointFilePath,
      worktreeId: WORKTREE,
      leaseId: 'lease_reused',
      acquiredAt: '2026-08-28T12:00:00.000Z',
      expiresAtMs: Date.now() + 60_000
    })
    writeFenceSentinel({
      endpointFilePath,
      worktreeId: WORKTREE,
      leaseId: 'lease_reused',
      acquiredAt: '2026-08-28T12:01:00.000Z',
      expiresAtMs: Date.now() + 120_000
    })

    expect(
      clearFenceSentinel(endpointFilePath, WORKTREE, {
        leaseId: 'lease_reused',
        acquiredAt: '2026-08-28T12:00:00.000Z'
      })
    ).toBe(false)
    const current = readFileSync(fenceFileFor(endpointFilePath, WORKTREE), 'utf8')
    expect(current.split('\n')[3]).toBe('2026-08-28T12:01:00.000Z')
    expect(fenceSentinelDenies(current, WORKTREE, Date.now())).toBe(true)
  })
})

describe('the shell reader agrees with the writer', () => {
  /** The managed script computes the filename with `tail -c 64 | tr`, with no
   *  runtime available. A transform that disagreed would MISS the sentinel and
   *  allow the mutation, so the two are pinned against each other here. */
  it('derives the identical filename in /bin/sh', () => {
    for (const worktreeId of [
      WORKTREE,
      'repo_a::/tmp/x',
      'repo_a::/var/folders/97/T/orca-bind-tree-B5XQTP',
      'plain-id-with-no-separator'
    ]) {
      const shell = spawnSync(
        '/bin/sh',
        ['-c', `printf %s "$1" | tail -c 64 | tr -c 'A-Za-z0-9._-' '_'`, 'sh', worktreeId],
        { encoding: 'utf8' }
      )
      expect(shell.stdout).toBe(fenceKeyFor(worktreeId))
    }
  })

  it('reads the same two fields the writer emits', () => {
    const endpointFilePath = endpoint()
    const expiresAtMs = Date.now() + 60_000
    const path = writeFenceSentinel({
      endpointFilePath,
      worktreeId: WORKTREE,
      leaseId: 'lease_1',
      acquiredAt: ACQUIRED_AT,
      expiresAtMs
    })
    const read = spawnSync(
      '/bin/sh',
      ['-c', `printf '%s|%s' "$(sed -n '1p' "$1")" "$(sed -n '2p' "$1")"`, 'sh', path],
      { encoding: 'utf8' }
    )
    expect(read.stdout).toBe(`${WORKTREE}|${Math.ceil(expiresAtMs / 1000)}`)
  })
})

describe('writeFenceSentinel is atomic', () => {
  it('leaves no partial file for a reader to misread', () => {
    const endpointFilePath = endpoint()
    const path = writeFenceSentinel({
      endpointFilePath,
      worktreeId: WORKTREE,
      leaseId: 'lease_1',
      acquiredAt: ACQUIRED_AT,
      expiresAtMs: Date.now() + 60_000
    })
    // A half-written marker whose first line was truncated would read as "not
    // this workspace" and allow the mutation.
    writeFileSync(`${path}.leftover`, 'ignored')
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
    expect(readFileSync(path, 'utf8').split('\n')).toHaveLength(5)
  })
})

describe('the shell scan matches the multi-record model', () => {
  it('finds the right record among colliding markers, and no stale one', () => {
    const suffix = '/workspaces/orca-jb/jb-workflow-control-plane-b/deeply/nested/tree'
    const first = `repo_a::/Users/one${suffix}`
    const second = `repo_b::/Users/two${suffix}`
    const endpointFilePath = endpoint()
    writeFenceSentinel({
      endpointFilePath,
      worktreeId: first,
      leaseId: 'lease_same',
      acquiredAt: ACQUIRED_AT,
      expiresAtMs: Date.now() + 60_000
    })
    writeFenceSentinel({
      endpointFilePath,
      worktreeId: second,
      leaseId: 'lease_same',
      acquiredAt: ACQUIRED_AT,
      expiresAtMs: Date.now() + 60_000
    })
    const dir = join(endpointFilePath, '..', 'fence')
    // The same glob-then-compare the managed script performs.
    const scan = (worktreeId: string): string =>
      spawnSync(
        '/bin/sh',
        [
          '-c',
          [
            "key=$(printf %s \"$2\" | tail -c 64 | tr -c 'A-Za-z0-9._-' '_')",
            'now=$(date +%s)',
            'for f in "$1/$key".*.fence; do',
            '  [ -f "$f" ] || continue',
            '  [ "$(sed -n \'1p\' "$f")" = "$2" ] || continue',
            '  e=$(sed -n \'2p\' "$f")',
            '  [ "$e" -gt "$now" ] || continue',
            '  printf DENY; exit 0',
            'done',
            'printf ALLOW'
          ].join('\n'),
          'sh',
          dir,
          worktreeId
        ],
        { encoding: 'utf8' }
      ).stdout
    expect(scan(first)).toBe('DENY')
    expect(scan(second)).toBe('DENY')
    expect(scan(`repo_c::/Users/three${suffix}`)).toBe('ALLOW')
  })
})
