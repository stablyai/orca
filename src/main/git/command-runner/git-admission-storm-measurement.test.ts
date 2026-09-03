/**
 * POSIX-only measurement: a PATH-injected git fixture exercises the real spawn path.
 * Timing distributions are reported for field comparison; CI assertions stay structural.
 */
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from './git-exec-file'
import {
  GIT_ADMISSION_AGING_MS,
  GitAdmissionScheduler,
  MAX_GIT_CHILDREN,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests,
  type GitAdmissionEvent
} from './git-subprocess-admission'

type StormMeasurement = {
  mode: 'disabled' | 'enabled'
  maxConcurrentChildren: number
  eventLoopMaxDriftMs: number
  eventLoopP99DriftMs: number
  interactiveP50Ms: number
  interactiveP95Ms: number
  totalWallMs: number
  admissionEvents: GitAdmissionEvent[]
  interactiveQueueSnapshots: InteractiveQueueSnapshot[]
}

type InteractiveQueueSnapshot = {
  commandLabel: string
  backgroundWaiterIds: number[]
}

const tempRoots: string[] = []
const originalAdmissionDisabled = process.env.ORCA_GIT_ADMISSION_DISABLED

afterEach(async () => {
  if (originalAdmissionDisabled === undefined) {
    delete process.env.ORCA_GIT_ADMISSION_DISABLED
  } else {
    process.env.ORCA_GIT_ADMISSION_DISABLED = originalAdmissionDisabled
  }
  _resetGitAdmissionForTests()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)]
}

async function liveChildCount(stateDir: string): Promise<number> {
  return (await readdir(stateDir)).filter((name) => name.endsWith('.live')).length
}

async function createStubGit(root: string): Promise<string> {
  const binDir = path.join(root, 'bin')
  await mkdir(binDir)
  const stubPath = path.join(binDir, 'git')
  await writeFile(
    stubPath,
    `#!/bin/sh
set -eu
live="$ORCA_STUB_STATE_DIR/$ORCA_STUB_ID.live"
: > "$live"
trap 'rm -f "$live"' EXIT HUP INT TERM
sleep "$(awk "BEGIN { print $ORCA_STUB_SLEEP_MS / 1000 }")"
printf 'stub:%s\\n' "$*"
`
  )
  await chmod(stubPath, 0o755)
  return binDir
}

function setAdmissionMode(mode: StormMeasurement['mode']): void {
  if (mode === 'disabled') {
    process.env.ORCA_GIT_ADMISSION_DISABLED = '1'
  } else {
    delete process.env.ORCA_GIT_ADMISSION_DISABLED
  }
}

async function measureStorm(mode: StormMeasurement['mode']): Promise<StormMeasurement> {
  setAdmissionMode(mode)
  const admissionEvents: GitAdmissionEvent[] = []
  const admissionClockStartedAt = performance.now()
  _resetGitAdmissionForTests(
    new GitAdmissionScheduler({
      now: () => Math.min(performance.now() - admissionClockStartedAt, GIT_ADMISSION_AGING_MS - 1),
      onAdmissionEvent: (event) => admissionEvents.push(event)
    })
  )
  const root = await mkdtemp(path.join(tmpdir(), `orca-git-storm-${mode}-`))
  tempRoots.push(root)
  const stateDir = path.join(root, 'state')
  await mkdir(stateDir)
  const binDir = await createStubGit(root)
  const repoDirs = await Promise.all(
    Array.from({ length: 6 }, async (_, index) => {
      const repoDir = path.join(root, `repo-${index}`)
      await mkdir(repoDir)
      return repoDir
    })
  )
  const baseEnv = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` }
  const startedAt = performance.now()
  const drifts: number[] = []
  let nextJankSample = performance.now() + 50
  const jankTimer = setInterval(() => {
    const now = performance.now()
    drifts.push(Math.max(0, now - nextJankSample))
    nextJankSample = now + 50
  }, 50)
  let maxConcurrentChildren = 0
  const censusTimer = setInterval(() => {
    void liveChildCount(stateDir).then((count) => {
      maxConcurrentChildren = Math.max(maxConcurrentChildren, count)
    })
  }, 5)

  const background = Array.from({ length: 60 }, (_, index) =>
    gitExecFileAsync(['status', '--porcelain=v2', `storm-${index}`], {
      cwd: repoDirs[index % repoDirs.length],
      env: {
        ...baseEnv,
        ORCA_STUB_ID: `background-${index}`,
        ORCA_STUB_SLEEP_MS: index % 10 === 0 ? '5000' : '200',
        ORCA_STUB_STATE_DIR: stateDir
      },
      admissionTier: 'background'
    })
  )
  const interactiveQueueSnapshots: InteractiveQueueSnapshot[] = []
  const interactiveLatencies = await Promise.all(
    Array.from(
      { length: 10 },
      (_, index) =>
        new Promise<number>((resolve, reject) => {
          setTimeout(
            () => {
              void (async () => {
                const concurrentAtInjection = await liveChildCount(stateDir)
                const commandStartedAt = performance.now()
                const commandLabel = `interactive-${index}`
                interactiveQueueSnapshots.push({
                  commandLabel,
                  backgroundWaiterIds: _gitAdmissionSnapshotForTests()
                    .queuedWaiters.filter((waiter) => waiter.tier === 'background')
                    .map((waiter) => waiter.id)
                })
                await gitExecFileAsync(['rev-parse', commandLabel], {
                  cwd: repoDirs[index % repoDirs.length],
                  env: {
                    ...baseEnv,
                    ORCA_STUB_ID: `interactive-${index}`,
                    ORCA_STUB_SLEEP_MS: String(Math.max(10, concurrentAtInjection * 12)),
                    ORCA_STUB_STATE_DIR: stateDir
                  },
                  admissionTier: 'interactive'
                })
                resolve(performance.now() - commandStartedAt)
              })().catch(reject)
            },
            50 * (index + 1)
          )
        })
    )
  )
  await Promise.all(background)
  clearInterval(censusTimer)
  clearInterval(jankTimer)
  maxConcurrentChildren = Math.max(maxConcurrentChildren, await liveChildCount(stateDir))
  const totalWallMs = performance.now() - startedAt
  return {
    mode,
    maxConcurrentChildren,
    eventLoopMaxDriftMs: Math.max(0, ...drifts),
    eventLoopP99DriftMs: percentile(drifts, 0.99),
    interactiveP50Ms: percentile(interactiveLatencies, 0.5),
    interactiveP95Ms: percentile(interactiveLatencies, 0.95),
    totalWallMs,
    admissionEvents,
    interactiveQueueSnapshots
  }
}

function formatMeasurementTable(rows: readonly StormMeasurement[]): string {
  const rounded = rows.map((row) => ({
    mode: row.mode,
    maxConcurrentChildren: row.maxConcurrentChildren,
    eventLoopMaxDriftMs: row.eventLoopMaxDriftMs.toFixed(1),
    eventLoopP99DriftMs: row.eventLoopP99DriftMs.toFixed(1),
    interactiveP50Ms: row.interactiveP50Ms.toFixed(1),
    interactiveP95Ms: row.interactiveP95Ms.toFixed(1),
    totalWallMs: row.totalWallMs.toFixed(1)
  }))
  return JSON.stringify(rounded)
}

function assertAdmissionLedger(measurement: StormMeasurement): void {
  const activeWaiters = new Set<number>()
  const grantSequenceByWaiter = new Map<number, number>()
  const grantByLabel = new Map<string, GitAdmissionEvent>()

  measurement.admissionEvents.forEach((event, index) => {
    expect(event.sequence).toBe(index)
    if (event.phase === 'grant') {
      activeWaiters.add(event.waiterId)
      grantSequenceByWaiter.set(event.waiterId, event.sequence)
      const label = event.args.find((arg) => arg.startsWith('interactive-'))
      if (label) {
        grantByLabel.set(label, event)
      }
    } else {
      expect(activeWaiters.delete(event.waiterId)).toBe(true)
    }
    expect(activeWaiters.size).toBeLessThanOrEqual(MAX_GIT_CHILDREN)
    for (const budget of event.budgets) {
      expect(budget.baseUsed).toBeLessThanOrEqual(budget.baseCapacity)
      expect(budget.headroomUsed).toBeLessThanOrEqual(budget.headroomCapacity)
    }
  })
  expect(activeWaiters.size).toBe(0)

  for (const snapshot of measurement.interactiveQueueSnapshots) {
    const interactiveGrant = grantByLabel.get(snapshot.commandLabel)
    expect(interactiveGrant).toBeDefined()
    const preceded = snapshot.backgroundWaiterIds.filter(
      (waiterId) => interactiveGrant!.sequence < (grantSequenceByWaiter.get(waiterId) ?? Infinity)
    ).length
    expect(preceded).toBeGreaterThanOrEqual(Math.ceil(snapshot.backgroundWaiterIds.length * 0.9))
  }
}

describe.skipIf(process.platform === 'win32')('git admission storm measurement', () => {
  it('reports bounded-concurrency before and after measurements', async () => {
    const disabled = await measureStorm('disabled')
    const enabled = await measureStorm('enabled')
    console.info(`GIT_ADMISSION_STORM_MEASUREMENT=${formatMeasurementTable([disabled, enabled])}`)
    assertAdmissionLedger(enabled)
  })

  // Output parity lives in git-admission-output-parity.test.ts: it needs real git,
  // not the PATH stub, so it runs on win32 too and cannot share this file's gate.
})
