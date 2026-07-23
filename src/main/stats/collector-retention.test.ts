import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir: string
const statsPath = (): string => join(userDataDir, 'orca-stats.json')

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

async function importCollector() {
  return import('./collector')
}

describe('StatsCollector retention bounds', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), 'orca-stats-retention-'))
    vi.resetModules()
  })

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('starts fresh without reading an oversized sparse stats file', async () => {
    const { StatsCollector, STATS_FILE_MAX_BYTES, initStatsPath } = await importCollector()
    const descriptor = openSync(statsPath(), 'w')
    ftruncateSync(descriptor, STATS_FILE_MAX_BYTES + 1)
    closeSync(descriptor)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    initStatsPath()

    const collector = new StatsCollector()

    expect(collector.getSummary()).toEqual({
      totalAgentsSpawned: 0,
      totalPRsCreated: 0,
      totalAgentTimeMs: 0,
      firstEventAt: null
    })
    expect(error).toHaveBeenCalledWith(
      '[stats] Failed to load stats, starting fresh:',
      expect.objectContaining({ name: 'NodeFileReadTooLargeError' })
    )
    collector.flush()
  })

  it('normalizes loaded event and PR-dedup arrays to their persisted limits', async () => {
    const { StatsCollector, STATS_COUNTED_PR_MAX_ENTRIES, STATS_EVENT_MAX_ENTRIES, initStatsPath } =
      await importCollector()
    writeFileSync(
      statsPath(),
      JSON.stringify({
        schemaVersion: 1,
        events: Array.from({ length: STATS_EVENT_MAX_ENTRIES + 3 }, (_, at) => ({
          type: 'agent_start',
          at
        })),
        aggregates: {
          totalAgentsSpawned: 123,
          totalPRsCreated: 456,
          totalAgentTimeMs: 789,
          countedPRs: Array.from(
            { length: STATS_COUNTED_PR_MAX_ENTRIES + 3 },
            (_, index) => `https://example.test/pr/${index}`
          ),
          firstEventAt: 0
        }
      })
    )
    initStatsPath()
    const collector = new StatsCollector()

    collector.flush()

    const persisted = JSON.parse(readFileSync(statsPath(), 'utf8'))
    expect(persisted.events).toHaveLength(STATS_EVENT_MAX_ENTRIES)
    expect(persisted.events[0].at).toBe(3)
    expect(persisted.aggregates.countedPRs).toHaveLength(STATS_COUNTED_PR_MAX_ENTRIES)
    expect(persisted.aggregates.countedPRs[0]).toBe('https://example.test/pr/3')
    expect(collector.getSummary()).toMatchObject({
      totalAgentsSpawned: 123,
      totalPRsCreated: 456,
      totalAgentTimeMs: 789
    })
  })

  it('retains only the newest events immediately and persists them in order', async () => {
    const { StatsCollector, STATS_EVENT_MAX_ENTRIES, initStatsPath } = await importCollector()
    initStatsPath()
    const collector = new StatsCollector()
    const internals = collector as unknown as { events: unknown[] }

    for (let at = 0; at < STATS_EVENT_MAX_ENTRIES + 3; at++) {
      collector.record({ type: 'agent_start', at })
      expect(internals.events.length).toBeLessThanOrEqual(STATS_EVENT_MAX_ENTRIES)
    }

    collector.flush()
    const persisted = JSON.parse(readFileSync(statsPath(), 'utf8'))
    expect(persisted.events).toHaveLength(STATS_EVENT_MAX_ENTRIES)
    expect(persisted.events[0].at).toBe(3)
    expect(persisted.events.at(-1).at).toBe(STATS_EVENT_MAX_ENTRIES + 2)
  })

  it('accepts an exact-limit event and drops a one-byte-larger event', async () => {
    const { StatsCollector, STATS_EVENT_MAX_BYTES, STATS_FILE_MAX_BYTES, initStatsPath } =
      await importCollector()
    initStatsPath()
    const collector = new StatsCollector()
    const exactEvent = { type: 'agent_start' as const, at: 1, meta: { payload: '' } }
    const eventOverhead = Buffer.byteLength(JSON.stringify(exactEvent), 'utf8')
    exactEvent.meta.payload = 'x'.repeat(STATS_EVENT_MAX_BYTES - eventOverhead)
    const oversizedEvent = {
      ...exactEvent,
      meta: { payload: `${exactEvent.meta.payload}x` }
    }

    expect(Buffer.byteLength(JSON.stringify(exactEvent), 'utf8')).toBe(STATS_EVENT_MAX_BYTES)
    collector.record(exactEvent)
    collector.record(oversizedEvent)
    collector.flush()

    const persisted = JSON.parse(readFileSync(statsPath(), 'utf8'))
    expect(persisted.events).toEqual([exactEvent])
    expect(collector.getSummary().totalAgentsSpawned).toBe(2)
    expect(Buffer.byteLength(JSON.stringify(persisted), 'utf8')).toBeLessThanOrEqual(
      STATS_FILE_MAX_BYTES
    )
  })

  it('evicts oldest events until the aggregate event-byte budget fits', async () => {
    const { StatsCollector, STATS_EVENT_MAX_BYTES, STATS_EVENT_MAX_RETAINED_BYTES, initStatsPath } =
      await importCollector()
    initStatsPath()
    const collector = new StatsCollector()
    const eventCount = STATS_EVENT_MAX_RETAINED_BYTES / STATS_EVENT_MAX_BYTES + 1
    for (let at = 0; at < eventCount; at++) {
      const event = { type: 'agent_start' as const, at, meta: { payload: '' } }
      const overhead = Buffer.byteLength(JSON.stringify(event), 'utf8')
      event.meta.payload = 'x'.repeat(STATS_EVENT_MAX_BYTES - overhead)
      collector.record(event)
    }

    collector.flush()

    const persisted = JSON.parse(readFileSync(statsPath(), 'utf8'))
    expect(persisted.events).toHaveLength(eventCount - 1)
    expect(persisted.events[0].at).toBe(1)
    expect(persisted.events.at(-1).at).toBe(eventCount - 1)
  })

  it('closes the oldest live agent when the live-session ceiling is reached', async () => {
    const { StatsCollector, STATS_LIVE_AGENT_MAX_ENTRIES, initStatsPath } = await importCollector()
    initStatsPath()
    const collector = new StatsCollector()
    const internals = collector as unknown as { liveAgents: Map<string, number> }

    for (let index = 0; index <= STATS_LIVE_AGENT_MAX_ENTRIES; index++) {
      collector.onAgentStart(`pty-${index}`, 1_000 + index)
    }

    expect(internals.liveAgents).toHaveLength(STATS_LIVE_AGENT_MAX_ENTRIES)
    expect(internals.liveAgents.has('pty-0')).toBe(false)
    expect(internals.liveAgents.has(`pty-${STATS_LIVE_AGENT_MAX_ENTRIES}`)).toBe(true)
    expect(collector.getSummary().totalAgentTimeMs).toBe(STATS_LIVE_AGENT_MAX_ENTRIES)

    collector.onAgentStop('pty-0', 100_000)
    expect(collector.getSummary().totalAgentTimeMs).toBe(STATS_LIVE_AGENT_MAX_ENTRIES)
    collector.flush()
  })

  it('bounds live-agent ids by individual and aggregate bytes', async () => {
    const {
      StatsCollector,
      STATS_LIVE_AGENT_ID_MAX_BYTES,
      STATS_LIVE_AGENT_MAX_RETAINED_ID_BYTES,
      initStatsPath
    } = await importCollector()
    initStatsPath()
    const collector = new StatsCollector()
    const internals = collector as unknown as { liveAgents: Map<string, number> }
    const retainedCount = STATS_LIVE_AGENT_MAX_RETAINED_ID_BYTES / STATS_LIVE_AGENT_ID_MAX_BYTES
    const id = (index: number): string =>
      `${String(index).padStart(4, '0')}${'x'.repeat(STATS_LIVE_AGENT_ID_MAX_BYTES - 4)}`

    for (let index = 0; index <= retainedCount; index++) {
      collector.onAgentStart(id(index), index)
    }
    collector.onAgentStart('x'.repeat(STATS_LIVE_AGENT_ID_MAX_BYTES + 1), 10_000)

    expect(internals.liveAgents).toHaveLength(retainedCount)
    expect(internals.liveAgents.has(id(0))).toBe(false)
    expect(internals.liveAgents.has(id(retainedCount))).toBe(true)
    expect(
      [...internals.liveAgents.keys()].reduce(
        (bytes, ptyId) => bytes + Buffer.byteLength(ptyId, 'utf8'),
        0
      )
    ).toBe(STATS_LIVE_AGENT_MAX_RETAINED_ID_BYTES)
    collector.flush()
  })

  it('bounds counted PR urls by individual and aggregate serialized bytes', async () => {
    const {
      StatsCollector,
      STATS_COUNTED_PR_MAX_RETAINED_BYTES,
      STATS_COUNTED_PR_URL_MAX_BYTES,
      initStatsPath
    } = await importCollector()
    initStatsPath()
    const collector = new StatsCollector()
    const internals = collector as unknown as { aggregates: { countedPRs: string[] } }
    const retainedCount = STATS_COUNTED_PR_MAX_RETAINED_BYTES / STATS_COUNTED_PR_URL_MAX_BYTES
    const url = (index: number): string => {
      const prefix = `https://example.test/${String(index).padStart(4, '0')}/`
      return `${prefix}${'x'.repeat(STATS_COUNTED_PR_URL_MAX_BYTES - 2 - prefix.length)}`
    }

    for (let index = 0; index <= retainedCount; index++) {
      collector.record({ type: 'pr_created', at: index, meta: { prUrl: url(index) } })
    }
    const oversizedUrl = 'x'.repeat(STATS_COUNTED_PR_URL_MAX_BYTES - 1)
    collector.record({ type: 'pr_created', at: 10_000, meta: { prUrl: oversizedUrl } })

    expect(Buffer.byteLength(JSON.stringify(url(0)), 'utf8')).toBe(STATS_COUNTED_PR_URL_MAX_BYTES)
    expect(internals.aggregates.countedPRs).toHaveLength(retainedCount)
    expect(collector.hasCountedPR(url(0))).toBe(false)
    expect(collector.hasCountedPR(url(retainedCount))).toBe(true)
    expect(collector.hasCountedPR(oversizedUrl)).toBe(false)
    collector.flush()
  })
})
