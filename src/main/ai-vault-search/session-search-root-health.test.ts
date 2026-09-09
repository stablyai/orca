import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  sessionSearchRootHealth,
  underDegradedRoot,
  type SessionSearchRootState
} from './session-search-root-health'

const CAN_DENY_READ = process.platform !== 'win32' && process.getuid?.() !== 0

let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ss-root-health-'))
  roots.push(root)
  return root
}

function health(args: {
  listings: { root: string; files: number }[]
  issues?: Parameters<typeof sessionSearchRootHealth>[0]['issues']
  previous?: Map<string, SessionSearchRootState>
  census?: boolean
  held?: readonly string[]
}) {
  return sessionSearchRootHealth({
    listings: args.listings,
    issues: args.issues ?? [],
    previous: args.previous ?? new Map(),
    census: args.census ?? true,
    holdsFiles: (root) => (args.held ?? []).includes(root)
  })
}

it('leaves an agent that is simply not installed alone', async () => {
  const root = await tempRoot()
  const result = await health({ listings: [{ root: join(root, 'never-created'), files: 0 }] })
  expect(result.degraded).toEqual([])
})

it('never probes a root that returned files, and records it as healthy', async () => {
  // The path does not exist, so a probe would report it degraded; a root that
  // yielded transcripts is readable by construction and must not be re-checked.
  const result = await health({ listings: [{ root: '/definitely/not/here', files: 3 }] })
  expect(result.degraded).toEqual([])
  expect(result.states.get('/definitely/not/here')).toEqual({
    lastHealthyCount: 3,
    emptySweeps: 0
  })
})

it.skipIf(!CAN_DENY_READ)('keeps a root that cannot be listed degraded indefinitely', async () => {
  const root = await tempRoot()
  const blocked = join(root, 'blocked')
  await mkdir(blocked)
  await chmod(blocked, 0o000)
  try {
    let previous = new Map<string, SessionSearchRootState>([
      [blocked, { lastHealthyCount: 9, emptySweeps: 0 }]
    ])
    for (let sweep = 0; sweep < 5; sweep++) {
      const result = await health({ listings: [{ root: blocked, files: 0 }], previous })
      expect(result.degraded).toHaveLength(1)
      expect(result.degraded[0]?.root).toBe(blocked)
      previous = result.states
    }
    // Never believed to be empty, so its last healthy count is never given up.
    expect(previous.get(blocked)?.lastHealthyCount).toBe(9)
  } finally {
    await chmod(blocked, 0o755)
  }
})

it('believes a readable root that lists empty twice, and not once', async () => {
  const root = await tempRoot()
  const emptied = join(root, 'emptied')
  await mkdir(emptied)

  const first = await health({
    listings: [{ root: emptied, files: 0 }],
    previous: new Map([[emptied, { lastHealthyCount: 4, emptySweeps: 0 }]])
  })
  // One sweep cannot tell an emptied tree from a freshly unmounted one.
  expect(first.degraded).toHaveLength(1)

  const second = await health({ listings: [{ root: emptied, files: 0 }], previous: first.states })
  expect(second.degraded).toEqual([])
  expect(second.states.get(emptied)).toEqual({ lastHealthyCount: 0, emptySweeps: 2 })
})

it('does not let a cycle advance the tally that decides a root was emptied', async () => {
  const root = await tempRoot()
  const emptied = join(root, 'emptied')
  await mkdir(emptied)
  // One full sweep has already seen it empty. Only a second sweep may conclude
  // anything; the cycles in between keep the fence and leave the tally alone.
  let previous = new Map([[emptied, { lastHealthyCount: 4, emptySweeps: 1 }]])

  for (let cycle = 0; cycle < 5; cycle++) {
    const result = await health({
      listings: [{ root: emptied, files: 0 }],
      previous,
      census: false
    })
    expect(result.degraded).toHaveLength(1)
    expect(result.states).toEqual(previous)
    previous = result.states
  }

  // The second sweep is what releases it.
  const sweep = await health({ listings: [{ root: emptied, files: 0 }], previous })
  expect(sweep.degraded).toEqual([])
})

it('carries a root-level scan issue through, but not a per-file notice', async () => {
  const root = await tempRoot()
  await mkdir(join(root, 'healthy'))
  const rootDir = join(root, 'healthy')
  const result = await health({
    listings: [{ root: rootDir, files: 2 }],
    issues: [
      { agent: 'claude', path: rootDir, message: 'The distro stopped responding.' },
      { agent: 'claude', path: rootDir, kind: 'notice', message: 'issue list truncated' },
      { agent: 'claude', path: join(rootDir, 'one.jsonl'), message: 'a single unreadable file' }
    ]
  })
  expect(result.degraded).toEqual([{ root: rootDir, reason: 'The distro stopped responding.' }])
})

it('fences files by real root boundaries', () => {
  const degraded = [{ root: '/a/agents', reason: 'gone' }]
  expect(underDegradedRoot('/a/agents/s/one.jsonl', degraded)).toBe(true)
  expect(underDegradedRoot('/b/agents/s/one.jsonl', degraded)).toBe(false)
  // A sibling whose name merely starts with the root is not inside it.
  expect(underDegradedRoot('/a/agents-old/one.jsonl', degraded)).toBe(false)
})

// Round 4, item 1: the evidence that a root once held transcripts has to
// outlive the process that saw it. Carried in memory it is empty on the first
// sweep after every restart, which is when a detached volume looks exactly
// like an agent that was never installed.
it('degrades a missing root the index still holds files under', async () => {
  const gone = join(await tempRoot(), 'unmounted')
  const result = await health({ listings: [{ root: gone, files: 0 }], held: [gone] })
  expect(result.degraded).toHaveLength(1)
  expect(result.degraded[0]?.root).toBe(gone)
})

it('leaves a missing root alone when the index holds nothing under it', async () => {
  const gone = join(await tempRoot(), 'never-installed')
  const result = await health({ listings: [{ root: gone, files: 0 }], held: [] })
  expect(result.degraded).toEqual([])
})

// Round 4, item 2: consecutive means consecutive. An empty sweep either side of
// an unreadable one is not two in a row, and adding them up retires a tree
// nobody emptied.
it.skipIf(!CAN_DENY_READ)('restarts the tally when a sweep cannot list the root', async () => {
  const root = await tempRoot()
  const flaky = join(root, 'flaky')
  await mkdir(flaky)
  let previous = new Map([[flaky, { lastHealthyCount: 4, emptySweeps: 0 }]])

  const first = await health({ listings: [{ root: flaky, files: 0 }], previous })
  expect(first.states.get(flaky)?.emptySweeps).toBe(1)

  await chmod(flaky, 0o000)
  try {
    const second = await health({
      listings: [{ root: flaky, files: 0 }],
      previous: first.states,
      held: [flaky]
    })
    expect(second.degraded).toHaveLength(1)
    expect(second.states.get(flaky)?.emptySweeps).toBe(0)
    previous = second.states
  } finally {
    await chmod(flaky, 0o755)
  }

  // The third sweep is only the first empty one in its run, so it still fences.
  const third = await health({ listings: [{ root: flaky, files: 0 }], previous })
  expect(third.degraded).toHaveLength(1)
})
