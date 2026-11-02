import type * as FsPromises from 'node:fs/promises'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentSessionRecoveryExportRoot,
  RECOVERY_EXPORT_MAX_BYTES,
  RECOVERY_EXPORT_SLOTS
} from '../agent-session-context-recovery-exports'
import { writeAgentSessionContextSnapshot } from '../agent-session-context-snapshots'
import { contextTransferFixture } from '../agent-session-wire/structured-agent-session-context-transfer.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from '../agent-session-wire/structured-agent-session-host-test-data'
import { captureRecoveryContext } from './context-transfer-capture'
import type { ContextTransferHandoff } from './context-transfer-record'

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rm: vi.fn(actual.rm) }
})

// N/10N contracts: count files, bytes and admissions at the export seam, never time.
const fixtures: Awaited<ReturnType<typeof contextTransferFixture>>[] = []
afterEach(async () => {
  vi.mocked(writeFile).mockClear()
  vi.mocked(rm).mockClear()
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()))
})

async function exporter() {
  const fixture = await contextTransferFixture()
  fixtures.push(fixture)
  const { journal } = await fixture.recoverSavedChat(async () => ({
    kind: 'injected',
    requestId: '1'
  }))
  const base = journal.contextTransfers.read().find((row) => row.kind === 'handoff')
  if (base?.kind !== 'handoff') {
    throw new Error('Missing frozen source')
  }
  const fence = () => fixture.store.requireWritableRecord(SESSION).lease.runtimeFence
  let ordinal = 0
  /** Adds saved text, then freezes a distinct authentic source cut for a new H. */
  const nextSource = async (text: string, id: string) => {
    await journal.appendItem(
      { provider: 'orca', clientMessageId: `saved-${ordinal++}` },
      { ...hostTestMessage(text), role: 'assistant' },
      { fence: fence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    return handoff(id)
  }
  const handoff = (id: string): ContextTransferHandoff => {
    const frozen = captureRecoveryContext(journal.snapshot(), journal.canonicalItemId)
    return { ...base, id, handoffId: id, sourceCursor: journal.cursor(), capture: frozen.capture }
  }
  const sourceText = () => captureRecoveryContext(journal.snapshot(), journal.canonicalItemId).text
  const exportOf = (h: ContextTransferHandoff) => journal.exportRecoveryContext(h)
  return { fixture, journal, nextSource, handoff, sourceText, exportOf }
}

async function exportFiles(stateDirectory: string) {
  const root = agentSessionRecoveryExportRoot(stateDirectory)
  const slots = await readdir(root).catch(() => [])
  let completed = 0
  let staged = 0
  let bytes = 0
  for (const slot of slots) {
    for (const file of await readdir(join(root, slot))) {
      bytes += (await stat(join(root, slot, file))).size
      if (file.endsWith('.part')) {
        staged += 1
      } else {
        completed += 1
      }
    }
  }
  return { slots: slots.length, completed, staged, bytes }
}

async function growingPopulation(requests: number) {
  const { fixture, nextSource, exportOf } = await exporter()
  let admitted = 0
  for (let i = 0; i < requests; i++) {
    if (await exportOf(await nextSource(`Saved answer ${i}`, `H-${i}`))) {
      admitted += 1
    }
  }
  return { admitted, ...(await exportFiles(fixture.root)) }
}

it('bounds recovery export files and bytes however many handoffs export', async () => {
  const n = Math.max(20, RECOVERY_EXPORT_SLOTS + 1)
  const small = await growingPopulation(n)
  const large = await growingPopulation(n * 10)
  for (const counts of [small, large]) {
    expect(counts.slots).toBeLessThanOrEqual(RECOVERY_EXPORT_SLOTS)
    expect(counts.completed).toBeLessThanOrEqual(RECOVERY_EXPORT_SLOTS)
    expect(counts.staged).toBe(0)
    expect(counts.bytes).toBeLessThanOrEqual(RECOVERY_EXPORT_SLOTS * RECOVERY_EXPORT_MAX_BYTES)
    expect(counts.completed).toBe(counts.admitted)
  }
  expect(large.completed).toBeLessThanOrEqual(small.completed + RECOVERY_EXPORT_SLOTS)
})

it('exports a full source within the byte bound and omits a larger one without writing', async () => {
  const { fixture, nextSource, sourceText, exportOf } = await exporter()
  const within = await exportOf(await nextSource('y'.repeat(200_000), 'within'))
  expect(within).toEqual(expect.any(String))
  expect(await readFile(within!, 'utf8')).toBe(sourceText())
  const before = await exportFiles(fixture.root)
  for (let i = 0; i < 10; i++) {
    await nextSource('z'.repeat(200_000), `grow-${i}`)
  }
  expect(Buffer.byteLength(sourceText(), 'utf8')).toBeGreaterThan(RECOVERY_EXPORT_MAX_BYTES)
  expect(await exportOf(await nextSource('last', 'oversized'))).toBeUndefined()
  expect(await exportFiles(fixture.root)).toEqual(before)
})

it('keeps every advertised export byte-identical and never gives its path to another source', async () => {
  const { fixture, nextSource, exportOf } = await exporter()
  const advertised = new Map<string, string>()
  const sources = new Map<string, ContextTransferHandoff>()
  for (let i = 0; i < RECOVERY_EXPORT_SLOTS * 3; i++) {
    const h = await nextSource(`Answer ${i}`, `H-${i}`)
    const path = await exportOf(h)
    if (path) {
      advertised.set(path, await readFile(path, 'utf8'))
      sources.set(path, h)
    }
  }
  const [first, h1] = [...sources.entries()][0]!
  const slotsBefore = (await exportFiles(fixture.root)).slots
  expect(await exportOf(h1)).toBe(first)
  expect((await exportFiles(fixture.root)).slots).toBe(slotsBefore)
  await writeAgentSessionContextSnapshot(fixture.root, SESSION, 'terminal hand-off text')
  await rm(join(first, '..'), { recursive: true, force: true })
  for (let i = 0; i < RECOVERY_EXPORT_SLOTS * 3; i++) {
    const path = await exportOf(await nextSource(`Later answer ${i}`, `late-${i}`))
    expect(advertised.has(path ?? '')).toBe(false)
  }
  for (const [path, text] of advertised) {
    if (path !== first) {
      expect(await readFile(path, 'utf8')).toBe(text)
    }
  }
})

const slotOf = (id: string) =>
  Number.parseInt(createHash('sha256').update(`${SESSION}/${id}`).digest('hex').slice(0, 8), 16) %
  RECOVERY_EXPORT_SLOTS
/** A handoff ID whose slot differs from every taken one. */
function idInFreeSlot(prefix: string, taken: Set<number>) {
  for (let i = 0; ; i++) {
    const id = `${prefix}-${i}`
    if (!taken.has(slotOf(id))) {
      taken.add(slotOf(id))
      return id
    }
  }
}

async function racedAndInterrupted(requests: number) {
  const { fixture, nextSource, exportOf } = await exporter()
  const residue = join(agentSessionRecoveryExportRoot(fixture.root), 'slot-0')
  await mkdir(residue, { recursive: true, mode: 0o700 })
  await writeFile(join(residue, 'crashed.txt.part'), 'partial')
  const taken = new Set([0])
  const fails = await nextSource('Fails before rename', idInFreeSlot('fails', taken))
  const stuck = await nextSource('Fails cleanup too', idInFreeSlot('stuck', taken))
  vi.mocked(writeFile).mockRejectedValueOnce(new Error('stage write failed'))
  expect(await exportOf(fails)).toBeUndefined()
  vi.mocked(writeFile).mockRejectedValueOnce(new Error('stage write failed'))
  vi.mocked(rm).mockRejectedValueOnce(new Error('cleanup failed'))
  expect(await exportOf(stuck)).toBeUndefined()
  const handoffs: ContextTransferHandoff[] = []
  for (let i = 0; i < requests; i++) {
    handoffs.push(await nextSource(`Raced ${i}`, `race-${i}`))
  }
  const paths = await Promise.all(handoffs.map((h) => exportOf(h)))
  return { admitted: paths.filter(Boolean).length, ...(await exportFiles(fixture.root)) }
}

it('holds the bound under racing exports, failed publication and leftover claims', async () => {
  const n = Math.max(20, RECOVERY_EXPORT_SLOTS + 1)
  for (const counts of [await racedAndInterrupted(n), await racedAndInterrupted(n * 10)]) {
    expect(counts.slots).toBeLessThanOrEqual(RECOVERY_EXPORT_SLOTS)
    expect(counts.completed + counts.staged).toBeLessThanOrEqual(RECOVERY_EXPORT_SLOTS)
    expect(counts.bytes).toBeLessThanOrEqual(2 * RECOVERY_EXPORT_SLOTS * RECOVERY_EXPORT_MAX_BYTES)
    // The crash residue and the failed cleanup each keep their slot.
    expect(counts.staged).toBe(1)
    expect(counts.completed).toBe(counts.admitted)
    expect(counts.completed).toBeLessThanOrEqual(RECOVERY_EXPORT_SLOTS - 2)
  }
})
