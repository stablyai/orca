// Local proof only (never committed): runs the real compaction on a copy of a large profile.
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { OrchestrationDbCompaction } from './orchestration-db-compaction'

const dir = join(tmpdir(), 'orca-44007-proof')
const pristine = process.env.ORCA_PROOF_PRISTINE || join(dir, 'pristine.db')
const file = process.env.ORCA_PROOF_DB || join(dir, 'orchestration.db')

/** A real-schema orchestration.db grown with mail to ~380 MiB, legacy (auto_vacuum=0), 150 MiB pruned oldest-first. */
function buildPristine(): void {
  mkdirSync(dir, { recursive: true })
  new OrchestrationDb(pristine).close()
  const db = new DatabaseSync(pristine)
  db.exec(
    'PRAGMA journal_mode=DELETE; PRAGMA auto_vacuum=NONE; VACUUM; PRAGMA journal_mode=WAL; PRAGMA synchronous=OFF'
  )
  const ins =
    db.prepare(`INSERT INTO messages (id, run_id, from_handle, to_handle, subject, body, type, thread_id, payload, read, sequence, created_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
  const body = 'Worker report: '.padEnd(900, 'lorem ipsum dolor sit amet ')
  const t0 = Date.UTC(2026, 0, 1)
  let i = 0
  while (statSync(pristine).size < 380 * 1048576) {
    db.exec('BEGIN')
    for (let k = 0; k < 20000; k++, i++) {
      const at = new Date(t0 + i * 1000).toISOString()
      ins.run(
        `msg_${i.toString(36).padStart(10, '0')}`,
        `run_${i >> 8}`,
        `term_${i % 97}`,
        `term_${i % 89}`,
        `status ${i}`,
        body,
        i % 5 ? 'status' : 'worker_done',
        `thr_${i >> 4}`,
        `{"k":${i}}`,
        i,
        at,
        at
      )
    }
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)')
  }
  const drop = Math.round((150 * 1048576) / (statSync(pristine).size / i))
  db.prepare('DELETE FROM messages WHERE sequence < ?').run(drop)
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
}

function fresh(): void {
  for (const suffix of [
    '',
    '-wal',
    '-shm',
    '-compacted',
    '-compacted-journal',
    '-replaced',
    '-compaction-attempts'
  ]) {
    rmSync(file + suffix, { force: true })
  }
  copyFileSync(pristine, file)
}

function lagProbe(): { stop: () => number } {
  let longest = 0
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last - 5)
    last = now
  }, 5)
  return {
    stop: () => {
      clearInterval(timer)
      return Math.round(longest * 10) / 10
    }
  }
}

it.runIf(process.env.ORCA_PROOF === '1')(
  'proof',
  async () => {
    if (!existsSync(pristine)) {
      buildPristine()
    }
    for (const variant of [
      'quiet',
      'writes-during-copy',
      'writes-during-copy',
      'writes-during-copy',
      'writes-during-copy',
      'writes-during-copy',
      'writes-during-copy',
      'writes-no-copy',
      'quiet'
    ] as const) {
      fresh()
      const before = statSync(file).size
      let t = performance.now()
      const orchestration = new OrchestrationDb(file)
      const openMs = performance.now() - t
      const compaction = new OrchestrationDbCompaction(orchestration, file, () => true, 1)
      t = performance.now()
      await compaction.tick()
      const coldTickMs = performance.now() - t
      // Warm, as the runtime's statements are by the time a file has been quiet for minutes.
      orchestration.createTask({ runId: 'run_legacy_local', spec: 'warm-up' })
      const warmFingerprintStart = performance.now()
      await compaction.tick()
      const secondTickMs = performance.now() - warmFingerprintStart
      const walBefore = statSync(`${file}-wal`).size
      if (variant === 'writes-during-copy-clean-wal') {
        orchestration.db.pragma('wal_checkpoint(TRUNCATE)')
      }
      const walAtCopy = statSync(`${file}-wal`).size
      const writeMs: number[] = []
      let writes = 0
      let longestWrite = 0
      const writer =
        variant !== 'quiet'
          ? setInterval(() => {
              const s = performance.now()
              orchestration.createTask({ runId: 'run_legacy_local', spec: `proof ${writes++}` })
              const ms = performance.now() - s
              writeMs.push(Math.round(ms * 10) / 10)
              longestWrite = Math.max(longestWrite, ms)
            }, 100)
          : undefined
      const probe = lagProbe()
      t = performance.now()
      await (variant === 'writes-no-copy'
        ? new Promise((resolve) => setTimeout(resolve, 1500))
        : compaction.tick())
      const copyWallMs = performance.now() - t
      clearInterval(writer)
      const longestBlockMs = probe.stop()
      let copyBytes: number | null = null
      try {
        copyBytes = statSync(`${file}-compacted`).size
      } catch {}
      const quit = lagProbe()
      t = performance.now()
      const swap = await compaction.swapAtQuit(async () => {})
      const swapWallMs = performance.now() - t
      const quitLongestBlockMs = quit.stop()
      try {
        orchestration.close()
      } catch {}
      const check = new OrchestrationDb(file)
      const integrity = check.db.pragma('quick_check', { simple: true })
      const autoVacuum = check.db.pragma('auto_vacuum', { simple: true })
      check.close()
      console.log(
        'PROOF',
        JSON.stringify({
          variant,
          platform: process.platform,
          beforeMiB: +(before / 1048576).toFixed(1),
          afterMiB: +(statSync(file).size / 1048576).toFixed(1),
          copyMiB: copyBytes === null ? null : +(copyBytes / 1048576).toFixed(1),
          openMs: Math.round(openMs),
          coldTickMs: +coldTickMs.toFixed(2),
          copyWallMs: Math.round(copyWallMs),
          longestMainBlockDuringCopyMs: longestBlockMs,
          writes,
          walBefore,
          walAtCopy,
          writeMs,
          secondTickMs: +secondTickMs.toFixed(2),
          longestWriteMs: +longestWrite.toFixed(2),
          swap,
          swapWallMs: Math.round(swapWallMs),
          longestMainBlockDuringSwapMs: quitLongestBlockMs,
          autoVacuum,
          integrity
        })
      )
    }
  },
  900_000
)
