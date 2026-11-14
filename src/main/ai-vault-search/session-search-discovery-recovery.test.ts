import './worker/session-search-worker.test-fixture'
import {
  notifySessionSearchFileChange,
  notifySessionSearchOverflow
} from './session-search-watcher.test-fixture'
import { appendFile, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as filesystem from '../native-chat/transcript-filesystem/wsl-transcript-fs-access'
import * as parser from '../ai-vault/parse-cache/session-scanner-parse-cache'
import * as policy from './session-search-filesystem'
import { SessionSearchIndexer } from './indexing/session-search-indexer'
import {
  CODEX_ROLLOUT_FILE,
  codexRolloutLines,
  parseTranscript
} from './indexing/session-search-transcript-fixtures'
import {
  FakeSessionSearchClock,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  claudeLines
} from './indexing/session-search-indexer-test-fixture'

it.each([100, 1000])(
  'reads only appended bytes after a late delivered update to a %s-turn transcript',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-recent-append')
    const clock = new FakeSessionSearchClock()
    const path = join(harness.claudeProjectDir, 'active.jsonl')
    const subject = new SessionSearchIndexer({
      discoveryPolicy: 'event-led',
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock
    })
    const reads = vi.spyOn(parser, 'parseAgentSessionFileCached')
    try {
      await writeClaudeTranscript(
        path,
        Array.from({ length: population }, () => 'archivedbody'),
        'active'
      )
      await subject.start()
      for (let cycle = 0; cycle < 3; cycle++) {
        reads.mockClear()
        const append = `${claudeLines(['appendedneedle'], 'active', population * 2 + cycle * 2).join('\n')}\n`
        await appendFile(path, append)
        clock.advance(20000)
        await subject.settled()
        expect(
          harness.read((db) =>
            db
              .prepare(
                "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'appendedneedle'"
              )
              .get()
          )
        ).toEqual({ n: cycle * 2 })
        notifySessionSearchFileChange(path)
        clock.advance(20000)
        await subject.settled()
        const call = reads.mock.calls.find(([candidate]) => candidate.file.path === path)
        expect(call).toBeDefined()
        // The parser stream needs only appended records; its fixed continuity probe does not grow with history.
        expect(call?.[2]?.bytesRead).toBeLessThanOrEqual(Buffer.byteLength(append) + 65536)
        expect(call?.[2]?.fullParses).toBe(0)
      }
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'appendedneedle'"
            )
            .get()
        )
      ).toEqual({ n: 6 })
    } finally {
      reads.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it('retries a refused first observation after settlement without another filesystem event', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-stat-retry')
  const clock = new FakeSessionSearchClock(),
    path = join(harness.claudeProjectDir, 'recovered.jsonl')
  const actual = filesystem.wslGatedStat
  let refused = false
  const probe = vi.spyOn(filesystem, 'wslGatedStat').mockImplementation((observed, ...rest) => {
    if (observed === path && !refused) {
      refused = true
      return Promise.reject(
        Object.assign(new Error('fixture temporary stat refusal'), { code: 'EIO' })
      )
    }
    return actual(observed, ...rest)
  })
  const subject = new SessionSearchIndexer({
    discoveryPolicy: 'event-led',
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock
  })
  try {
    await writeClaudeTranscript(path, ['recoveredneedle'], 'recovered')
    await subject.start()
    expect(refused).toBe(true)
    clock.advance(20000)
    await subject.settled()
    expect(
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'recoveredneedle'"
          )
          .get()
      )
    ).toEqual({ n: 2 })
  } finally {
    probe.mockRestore()
    await subject.close()
    await harness.cleanup()
  }
})

it('advances the discovery suffix during continuous updates and repeated overflow', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-crawl-fairness')
  const clock = new FakeSessionSearchClock(),
    root = harness.roots.claudeProjectsDir!
  const active = join(harness.claudeProjectDir, 'active.jsonl')
  const listings = vi.spyOn(filesystem, 'wslGatedReaddir')
  const subject = new SessionSearchIndexer({
    discoveryPolicy: 'event-led',
    databasePath: harness.databasePath,
    roots: harness.roots,
    historyDays: null,
    clock,
    discoveryDeadlineMs: 0
  })
  try {
    await writeClaudeTranscript(active, ['activebody'], 'active')
    for (let index = 0; index < 16; index++) {
      await writeClaudeTranscript(
        join(root, `bucket${index}`, 'history.jsonl'),
        ['frontierneedle'],
        `history${index}`
      )
    }
    await subject.start()
    listings.mockClear()
    const historicalMatches = () =>
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(DISTINCT session_row_id) AS n FROM messages JOIN messages_fts ON messages.id=messages_fts.rowid WHERE messages_fts MATCH 'frontierneedle'"
          )
          .get()
      )
    // Eighteen directories need at most six phases each, alternating with delivered dirty work.
    for (let cycle = 0; cycle < 224 && Number(historicalMatches()?.n ?? 0) < 16; cycle++) {
      await appendFile(
        active,
        `${claudeLines(['activeappend'], 'active', cycle * 2 + 10).join('\n')}\n`
      )
      notifySessionSearchFileChange(active)
      notifySessionSearchOverflow(root)
      clock.advance(20000)
      await subject.settled()
    }
    expect(historicalMatches()).toEqual({ n: 16 })
    // One in-progress epoch and its coalesced trailing catch-up must retain the historical suffix.
    expect(listings.mock.calls.filter(([path]) => path === root).length).toBeLessThanOrEqual(2)
  } finally {
    listings.mockRestore()
    await subject.close()
    await harness.cleanup()
  }
})

it.each([40, 400])(
  'polls %s retained files without rereading unchanged transcripts and retires a deletion',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-polling-delta')
    const clock = new FakeSessionSearchClock()
    const path = join(harness.claudeProjectDir, 'changed.jsonl')
    const deleted = join(harness.claudeProjectDir, 'deleted.jsonl')
    const polling = vi.spyOn(policy, 'sessionSearchRequiresPolling').mockResolvedValue(true)
    const reads = vi.spyOn(parser, 'parseAgentSessionFileCached')
    const subject = new SessionSearchIndexer({
      discoveryPolicy: 'event-led',
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock
    })
    try {
      await writeClaudeTranscript(path, ['originalbody'], 'changed')
      await writeClaudeTranscript(deleted, ['deletedneedle'], 'deleted')
      for (let index = 0; index < population; index++) {
        await writeClaudeTranscript(
          join(harness.claudeProjectDir, `${index}.jsonl`),
          ['archivebody'],
          `archive${index}`
        )
      }
      await subject.start()
      reads.mockClear()
      clock.advance(20000)
      await subject.settled()
      // Polling must observe membership, but unchanged observations create no transcript read work.
      expect(reads).not.toHaveBeenCalled()
      await appendFile(path, `${claudeLines(['pollchangedneedle'], 'changed', 10).join('\n')}\n`)
      await rm(deleted)
      clock.advance(20000)
      await subject.settled()
      expect(reads).toHaveBeenCalledTimes(1)
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'pollchangedneedle'"
            )
            .get()
        )
      ).toEqual({ n: 2 })
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'deletedneedle'"
            )
            .get()
        )
      ).toEqual({ n: 0 })
    } finally {
      reads.mockRestore()
      polling.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it.each([200, 2000])(
  'preserves legacy polling admission with %s message files',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-polling-content')
    const clock = new FakeSessionSearchClock()
    const storage = harness.roots.opencodeStorageDir!
    const primary = join(storage, 'session', 'project', 'ses_remote.json')
    const messages = join(storage, 'message', 'ses_remote')
    const polling = vi.spyOn(policy, 'sessionSearchRequiresPolling').mockResolvedValue(true)
    const subject = new SessionSearchIndexer({
      discoveryPolicy: 'event-led',
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock
    })
    try {
      await mkdir(join(storage, 'session', 'project'), { recursive: true })
      await mkdir(messages, { recursive: true })
      await writeFile(primary, JSON.stringify({ id: 'ses_remote', directory: '/repo/remote' }))
      await writeFile(
        join(messages, 'msg_1.json'),
        JSON.stringify({
          role: 'user',
          content: [{ type: 'text', text: 'originalremote' }],
          time: { created: 1777634000000 }
        })
      )
      for (let index = 0; index < population; index++) {
        await writeFile(join(messages, `msg_archived_${index}.json`), '{}')
      }
      await subject.start()
      const stats = vi.spyOn(filesystem, 'wslGatedStat')
      clock.advance(20000)
      await subject.settled()
      expect(stats.mock.calls.filter(([path]) => String(path).startsWith(messages))).toHaveLength(0)
      stats.mockRestore()
      await writeFile(
        join(messages, 'msg_2.json'),
        JSON.stringify({
          role: 'assistant',
          content: [{ type: 'text', text: 'remoteinputneedle' }],
          time: { created: 1777634001000 }
        })
      )
      clock.advance(20000)
      await subject.settled()
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'remoteinputneedle'"
            )
            .get()
        )
      ).toEqual({ n: 0 })
      await writeFile(
        primary,
        JSON.stringify({ id: 'ses_remote', directory: '/repo/remote', title: 'Updated primary' })
      )
      clock.advance(20000)
      await subject.settled()
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'remoteinputneedle'"
            )
            .get()
        )
      ).toEqual({ n: 1 })
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'originalremote'"
            )
            .get()
        )
      ).toEqual({ n: 1 })
    } finally {
      polling.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it.each(['first-file', 'accepted-file', 'directory'] as const)(
  'settles a persistently refused %s and recovers after a delivered change',
  async (kind) => {
    const harness = await openSessionSearchIndexerHarness('ss-refused-observation')
    const clock = new FakeSessionSearchClock()
    const directory = join(harness.roots.claudeProjectsDir ?? '', 'refused')
    const path = join(directory, 'history.jsonl')
    const subject = new SessionSearchIndexer({
      discoveryPolicy: 'event-led',
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock,
      fullSweepEveryCycles: 1000
    })
    const stat = filesystem.wslGatedStat,
      readdir = filesystem.wslGatedReaddir
    let refused = kind !== 'accepted-file'
    const statProbe = vi.spyOn(filesystem, 'wslGatedStat').mockImplementation((input, ...rest) => {
      if (refused && kind !== 'directory' && input === path) {
        return Promise.reject(Object.assign(new Error('fixture stat refusal'), { code: 'EACCES' }))
      }
      return stat(input, ...rest)
    })
    const directoryProbe = vi
      .spyOn(filesystem, 'wslGatedReaddir')
      .mockImplementation((input, ...rest) => {
        if (refused && kind === 'directory' && input === directory) {
          return Promise.reject(
            Object.assign(new Error('fixture listing refusal'), { code: 'EACCES' })
          )
        }
        return readdir(input, ...rest)
      })
    try {
      await writeClaudeTranscript(path, ['retainedrefusalneedle'], 'refused')
      await subject.start()
      if (kind === 'accepted-file') {
        refused = true
        notifySessionSearchFileChange(path)
      }
      for (let cycle = 0; cycle < 4; cycle++) {
        clock.advance(20000)
        await subject.settled()
      }
      expect(subject.status().phase).toBe('current')
      statProbe.mockClear()
      directoryProbe.mockClear()
      clock.advance(20000)
      await subject.settled()
      expect(statProbe.mock.calls.filter(([input]) => input === path)).toHaveLength(0)
      expect(directoryProbe.mock.calls.filter(([input]) => input === directory)).toHaveLength(0)
      refused = false
      await appendFile(path, `${claudeLines(['awakenedneedle'], 'refused', 20).join('\n')}\n`)
      notifySessionSearchFileChange(kind === 'directory' ? directory : path)
      for (let cycle = 0; cycle < 2; cycle++) {
        clock.advance(20000)
        await subject.settled()
      }
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'awakenedneedle'"
            )
            .get()
        )
      ).toEqual({ n: 2 })
      expect(
        harness.read((db) =>
          db
            .prepare(
              "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'retainedrefusalneedle'"
            )
            .get()
        )
      ).toEqual({ n: 2 })
      expect(subject.status().phase).toBe('current')
    } finally {
      statProbe.mockRestore()
      directoryProbe.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it.each([false, true])(
  'tracks the selected Kimi wire with polling=%s and retains refused input recovery',
  async (pollingMode) => {
    const harness = await openSessionSearchIndexerHarness('ss-kimi-selected')
    const clock = new FakeSessionSearchClock()
    const root = join(harness.root, 'kimi-home', 'sessions')
    const directory = join(root, 'workspace', 'session_selected')
    const path = join(directory, 'state.json')
    const wire = (id: string) => join(directory, 'agents', id, 'wire.jsonl')
    const message = (text: string) =>
      `${JSON.stringify({ type: 'context.append_message', message: { role: 'user', origin: { kind: 'user' }, content: text } })}\n`
    const polling = vi.spyOn(policy, 'sessionSearchRequiresPolling').mockResolvedValue(pollingMode)
    const actual = filesystem.wslGatedStat
    let refused = false
    const stats = vi.spyOn(filesystem, 'wslGatedStat').mockImplementation((input, ...rest) => {
      if (refused && input === wire('lead')) {
        return Promise.reject(
          Object.assign(new Error('fixture sidecar refusal'), { code: 'EACCES' })
        )
      }
      return actual(input, ...rest)
    })
    const subject = new SessionSearchIndexer({
      discoveryPolicy: 'event-led',
      databasePath: harness.databasePath,
      roots: { ...harness.roots, kimiSessionsDir: root },
      historyDays: null,
      clock,
      fullSweepEveryCycles: 1000
    })
    const matches = (term: string) =>
      harness.read((db) =>
        db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(term)
      )
    try {
      await mkdir(join(directory, 'agents', 'lead'), { recursive: true })
      await mkdir(join(directory, 'agents', 'main'), { recursive: true })
      await mkdir(join(directory, 'agents', 'next'), { recursive: true })
      await writeFile(
        path,
        JSON.stringify({ title: 'Selected agent', agents: { lead: { type: 'main' } } })
      )
      await writeFile(wire('lead'), message('originalselectedneedle'))
      await writeFile(wire('main'), message('nonselectedneedle'))
      await subject.start()
      expect(matches('originalselectedneedle')).toEqual({ n: 1 })
      expect(matches('nonselectedneedle')).toEqual({ n: 0 })
      await appendFile(wire('lead'), message('ordinarywireupdate'))
      notifySessionSearchFileChange(wire('lead'))
      clock.advance(20000)
      await subject.settled()
      expect(matches('ordinarywireupdate')).toEqual({ n: 1 })
      refused = true
      notifySessionSearchFileChange(wire('lead'))
      for (let cycle = 0; cycle < 4; cycle++) {
        clock.advance(20000)
        await subject.settled()
      }
      expect(subject.status().phase).toBe('current')
      refused = false
      await appendFile(wire('lead'), message('wireupdatedneedle'))
      if (pollingMode) {
        await subject.reconcile({ full: true })
      } else {
        notifySessionSearchFileChange(wire('lead'))
      }
      for (let cycle = 0; cycle < 2; cycle++) {
        clock.advance(20000)
        await subject.settled()
      }
      expect(matches('wireupdatedneedle')).toEqual({ n: 1 })
      await writeFile(wire('next'), message('newselectionneedle'))
      await writeFile(
        path,
        JSON.stringify({ title: 'Selected agent', agents: { next: { type: 'main' } } })
      )
      notifySessionSearchFileChange(path)
      clock.advance(20000)
      await subject.settled()
      expect(matches('newselectionneedle')).toEqual({ n: 1 })
      expect(matches('originalselectedneedle')).toEqual({ n: 0 })
      expect(matches('wireupdatedneedle')).toEqual({ n: 0 })
    } finally {
      stats.mockRestore()
      polling.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it.each([40, 400])(
  'cancels an unobserved %s-directory frontier while its sibling completes',
  async (population) => {
    const harness = await openSessionSearchIndexerHarness('ss-cancel-frontier')
    const root = harness.claudeProjectDir
    const removed = join(root, 'a-removed'),
      kept = join(root, 'z-kept')
    await mkdir(kept, { recursive: true })
    await writeFile(join(kept, 'kept.jsonl'), '{}\n')
    for (let index = 0; index < population; index++) {
      await mkdir(join(removed, `😀child-${index}`), { recursive: true })
    }
    const inventory = harness.inventory(root)
    const args = {
      rootDir: root,
      agent: 'claude' as const,
      limit: Infinity,
      extensions: ['.jsonl'],
      issues: []
    }
    const listings = vi.spyOn(filesystem, 'wslGatedReaddir')
    try {
      await inventory.drain(args, () => true, 12)
      const beforeRemoval = await inventory.drain(
        args,
        () => listings.mock.calls.some(([path]) => path === removed),
        12
      )
      expect(beforeRemoval.changes.map(({ file }) => file.path)).not.toContain(
        join(kept, 'kept.jsonl')
      )
      await rm(removed, { recursive: true })
      await inventory.invalidate(removed)
      listings.mockClear()
      const found: string[] = []
      // Each retained directory needs at most six phases; cancellation must also settle its frontier.
      for (let cycle = 0; cycle < 6 * (population + 3) && inventory.pending; cycle++) {
        found.push(
          ...(await inventory.drain(args, () => true, 12)).changes.map((change) => change.file.path)
        )
        await inventory.retryFailures()
      }
      expect(inventory.pending).toBe(false)
      expect(found).toContain(join(kept, 'kept.jsonl'))
    } finally {
      listings.mockRestore()
      await harness.cleanup()
    }
  }
)

it.each([
  { input: 'primary', failures: 1 },
  { input: 'sidecar', failures: 1 },
  { input: 'primary', failures: 3 }
])(
  'retains a deferred read through $failures refused $input observations',
  async ({ input, failures }) => {
    const harness = await openSessionSearchIndexerHarness('ss-admission-debt')
    const clock = new FakeSessionSearchClock()
    clock.costPerNowMs = 1000
    const directory = join(harness.roots.clineSessionsDir!, 'owed')
    const primary = join(directory, 'owed.json')
    const sidecar = join(directory, 'owed.messages.json')
    const polling = vi.spyOn(policy, 'sessionSearchRequiresPolling').mockResolvedValue(true)
    const actualStat = filesystem.wslGatedStat
    let refusing = false
    const probe = vi.spyOn(filesystem, 'wslGatedStat').mockImplementation((path, ...rest) => {
      if (refusing && path === (input === 'primary' ? primary : sidecar)) {
        return Promise.reject(
          Object.assign(new Error('fixture observation refusal'), { code: 'EIO' })
        )
      }
      return actualStat(path, ...rest)
    })
    const subject = new SessionSearchIndexer({
      discoveryPolicy: 'event-led',
      databasePath: harness.databasePath,
      roots: harness.roots,
      historyDays: null,
      clock,
      passDeadlineMs: 1000,
      discoveryDeadlineMs: Infinity
    })
    const matching = () =>
      harness.read((db) =>
        db
          .prepare(
            "SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'owedreadneedle'"
          )
          .get()
      )
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(primary, JSON.stringify({ session_id: 'owed', cwd: '/repo' }))
      await writeFile(
        sidecar,
        JSON.stringify({
          sessionId: 'owed',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'owedreadneedle' }] }]
        })
      )
      await utimes(primary, new Date('2024-01-01'), new Date('2024-01-01'))
      await writeClaudeTranscript(
        join(harness.claudeProjectDir, 'newer.jsonl'),
        ['newerbody'],
        'newer'
      )
      await subject.start()
      expect(matching()).toEqual({ n: 0 })
      expect(subject.status().filesDue).toBe(1)
      const accepted = await stat(primary)
      refusing = true
      for (let cycle = 0; cycle < failures; cycle++) {
        await subject.reconcile()
      }
      expect(matching()).toEqual({ n: 0 })
      refusing = false
      await subject.reconcile()
      if (failures === 3) {
        expect(matching()).toEqual({ n: 0 })
        expect(subject.status().filesDue).toBe(0)
        expect(subject.status().phase).not.toBe('indexing')
        await subject.reconcile({ full: true })
      }
      expect(matching()).toEqual({ n: 1 })
      expect(
        harness.read((db) =>
          db.prepare('SELECT mtime_ms, size_bytes FROM files WHERE path=?').get(primary)
        )
      ).toMatchObject({ mtime_ms: accepted.mtimeMs, size_bytes: accepted.size })
    } finally {
      probe.mockRestore()
      polling.mockRestore()
      await subject.close()
      await harness.cleanup()
    }
  }
)

it('keeps an accepted alias while its deferred replacement is owed by a held-out observation', async () => {
  const harness = await openSessionSearchIndexerHarness('ss-alias-admission-debt')
  const clock = new FakeSessionSearchClock()
  clock.costPerNowMs = 1000
  const primary = join(harness.roots.codexSessionsDir!, CODEX_ROLLOUT_FILE)
  const copyHome = join(harness.root, 'copied-home')
  const copyRoot = join(copyHome, 'sessions')
  const copy = join(copyRoot, CODEX_ROLLOUT_FILE)
  const roots = {
    ...harness.roots,
    defaultCodexHomeDir: dirname(harness.roots.codexSessionsDir!),
    additionalCodexSessionsDirs: [copyRoot]
  }
  const polling = vi.spyOn(policy, 'sessionSearchRequiresPolling').mockResolvedValue(false)
  const actualStat = filesystem.wslGatedStat
  let refusing = false
  const probe = vi.spyOn(filesystem, 'wslGatedStat').mockImplementation((path, ...rest) => {
    if (refusing && path === primary) {
      return Promise.reject(
        Object.assign(new Error('fixture observation refusal'), { code: 'EIO' })
      )
    }
    return actualStat(path, ...rest)
  })
  const subject = new SessionSearchIndexer({
    discoveryPolicy: 'event-led',
    databasePath: harness.databasePath,
    roots,
    historyDays: null,
    clock,
    passDeadlineMs: 1000,
    discoveryDeadlineMs: Infinity
  })
  const matching = (text: string) =>
    harness.read((db) =>
      db.prepare('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH ?').get(text)
    )
  const rollout = (text: string) =>
    `${codexRolloutLines(['echo'], 'plainresult', text).join('\n')}\n`
  const fixedTime = new Date('2024-01-01')
  try {
    await mkdir(dirname(primary), { recursive: true })
    await mkdir(copyRoot, { recursive: true })
    await writeFile(primary, rollout('canonicaloldneedle'))
    await utimes(primary, fixedTime, fixedTime)
    await subject.start()
    expect(matching('canonicaloldneedle')).toEqual({ n: 1 })
    // A foreground read can publish an alias before background discovery notices it.
    await writeFile(copy, rollout('predecessorowedneedle'))
    await parseTranscript(copy, 'codex', copyHome)
    await subject.settled()
    expect(matching('predecessorowedneedle')).toEqual({ n: 1 })
    await writeFile(primary, rollout('canonicalnewneedle'))
    await utimes(primary, fixedTime, fixedTime)
    notifySessionSearchFileChange(primary)
    await writeClaudeTranscript(
      join(harness.claudeProjectDir, 'newer.jsonl'),
      ['newerbody'],
      'newer'
    )
    await subject.reconcile()
    expect(matching('canonicalnewneedle')).toEqual({ n: 0 })
    expect(matching('canonicaloldneedle')).toEqual({ n: 1 })
    refusing = true
    notifySessionSearchOverflow(harness.roots.codexSessionsDir!)
    for (let cycle = 0; cycle < 3; cycle++) {
      await subject.reconcile()
    }
    refusing = false
    notifySessionSearchFileChange(copy)
    await subject.reconcile()
    expect(matching('predecessorowedneedle')).toEqual({ n: 1 })
    expect(matching('canonicalnewneedle')).toEqual({ n: 0 })
    expect(subject.status().phase).not.toBe('indexing')
    await subject.reconcile({ full: true })
    expect(matching('canonicalnewneedle')).toEqual({ n: 1 })
    await subject.settled()
    // Coverage and withdrawal each need a page and an empty-page acknowledgement.
    for (
      let cycle = 0;
      cycle < 6 &&
      (Number(matching('predecessorowedneedle')?.n) !== 0 || subject.status().phase === 'indexing');
      cycle++
    ) {
      await subject.reconcile()
    }
    expect(matching('canonicalnewneedle')).toEqual({ n: 1 })
    expect(matching('predecessorowedneedle')).toEqual({ n: 0 })
    expect(subject.status().phase).not.toBe('indexing')
  } finally {
    probe.mockRestore()
    polling.mockRestore()
    await subject.close()
    await harness.cleanup()
  }
})
