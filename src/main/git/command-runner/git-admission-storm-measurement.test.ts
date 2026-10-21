import { existsSync, watch } from 'node:fs'
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { gitExecFileAsync } from './git-exec-file'
import {
  GENERAL_CAP,
  GENERAL_HEADROOM,
  GitAdmissionScheduler,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests,
  type GitAdmissionEvent
} from './git-subprocess-admission'
import {
  assertAdmissionLedger,
  createStormRoot,
  formatMeasurementTable,
  measureStorm,
  type InteractiveQueueSnapshot
} from './git-admission-storm-test-fixture'

function waitForLiveChild(stateDir: string, id: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(stateDir)
    const finish = (error?: Error): void => {
      clearTimeout(deadline)
      watcher.close()
      signal.removeEventListener('abort', aborted)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const aborted = (): void => finish(new Error(`Aborted waiting for ${id}`))
    const deadline = setTimeout(() => finish(new Error(`Child ${id} did not start`)), 5_000)
    const check = (): void => {
      if (existsSync(path.join(stateDir, `${id}.live`))) {
        finish()
      }
    }
    watcher.on('change', check)
    watcher.once('error', finish)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) {
      aborted()
    } else {
      check()
    }
  })
}

async function verifySpawnContention(): Promise<void> {
  delete process.env.ORCA_GIT_ADMISSION_DISABLED
  const admissionEvents: GitAdmissionEvent[] = []
  _resetGitAdmissionForTests(
    new GitAdmissionScheduler({
      now: () => 0,
      onAdmissionEvent: (event) => admissionEvents.push(event)
    })
  )
  const root = await createStormRoot('contention')
  const stateDir = path.join(root, 'state')
  const gateDir = path.join(root, 'gates')
  const binDir = path.join(root, 'bin')
  await Promise.all([stateDir, gateDir, binDir].map((directory) => mkdir(directory)))
  const backgroundIds = Array.from({ length: GENERAL_CAP + 4 }, (_, index) => `background-${index}`)
  const headroomIds = Array.from({ length: GENERAL_HEADROOM }, (_, index) => `interactive-${index}`)
  const queuedIds = ['interactive-queued-0', 'interactive-queued-1']
  const ids = [...backgroundIds, ...headroomIds, ...queuedIds]
  const gates = await runProcess({
    program: 'mkfifo',
    args: ids.map((id) => path.join(gateDir, id))
  })
  expect(gates.code, gates.stderr).toBe(0)
  const stub = path.join(binDir, 'git')
  await writeFile(
    stub,
    `#!/bin/sh
set -eu
live="$ORCA_STUB_STATE_DIR/$ORCA_STUB_ID.live"
: > "$live"
trap 'rm -f "$live"' EXIT HUP INT TERM
IFS= read -r release < "$ORCA_STUB_GATE_DIR/$ORCA_STUB_ID"
printf 'stub:%s\\n' "$*"
`
  )
  await chmod(stub, 0o755)
  const controller = new AbortController()
  const commands = new Map<string, ReturnType<typeof gitExecFileAsync>>()
  const interactiveQueueSnapshots: InteractiveQueueSnapshot[] = []
  const start = (id: string, tier: 'background' | 'interactive'): void => {
    if (tier === 'interactive') {
      interactiveQueueSnapshots.push({
        commandLabel: id,
        backgroundWaiterIds: _gitAdmissionSnapshotForTests()
          .queuedWaiters.filter((waiter) => waiter.tier === 'background')
          .map((waiter) => waiter.id)
      })
    }
    const command = gitExecFileAsync([tier === 'background' ? 'status' : 'rev-parse', id], {
      cwd: root,
      admissionTier: tier,
      signal: controller.signal,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        ORCA_STUB_ID: id,
        ORCA_STUB_STATE_DIR: stateDir,
        ORCA_STUB_GATE_DIR: gateDir
      }
    })
    void command.catch(() => {})
    commands.set(id, command)
  }
  const release = async (id: string): Promise<void> => {
    await waitForLiveChild(stateDir, id, controller.signal)
    await writeFile(path.join(gateDir, id), 'release\n')
    await expect(commands.get(id)).resolves.toEqual({
      stdout: `stub:${id.startsWith('background-') ? 'status' : 'rev-parse'} ${id}\n`,
      stderr: ''
    })
  }
  try {
    backgroundIds.forEach((id) => start(id, 'background'))
    expect(_gitAdmissionSnapshotForTests().queued).toBe(4)
    headroomIds.forEach((id) => start(id, 'interactive'))
    queuedIds.forEach((id) => start(id, 'interactive'))
    expect(_gitAdmissionSnapshotForTests()).toMatchObject({
      queued: 6,
      budgets: { general: { baseUsed: GENERAL_CAP, headroomUsed: GENERAL_HEADROOM } }
    })
    await Promise.all(
      [...backgroundIds.slice(0, GENERAL_CAP), ...headroomIds].map((id) =>
        waitForLiveChild(stateDir, id, controller.signal)
      )
    )
    expect(await readdir(stateDir)).toHaveLength(GENERAL_CAP + GENERAL_HEADROOM)
    for (const [index, id] of queuedIds.entries()) {
      await release(backgroundIds[index])
      await waitForLiveChild(stateDir, id, controller.signal)
    }
    expect(_gitAdmissionSnapshotForTests().queuedWaiters.map((waiter) => waiter.tier)).toEqual([
      'background',
      'background',
      'background',
      'background'
    ])
    for (const id of [...headroomIds, ...queuedIds, ...backgroundIds.slice(queuedIds.length)]) {
      await release(id)
    }
    expect(admissionEvents.filter((event) => event.phase === 'grant')).toHaveLength(ids.length)
    expect(admissionEvents.filter((event) => event.phase === 'release')).toHaveLength(ids.length)
    assertAdmissionLedger({ admissionEvents, interactiveQueueSnapshots })
    expect(_gitAdmissionSnapshotForTests()).toMatchObject({
      queued: 0,
      budgets: { general: { baseUsed: 0, headroomUsed: 0 } }
    })
    expect(await readdir(stateDir)).toEqual([])
  } finally {
    controller.abort()
    await Promise.allSettled(commands.values())
  }
}

describe.skipIf(process.platform === 'win32')('git admission storm measurement', () => {
  it(
    'bounds real children and drains interactive work before the background backlog',
    verifySpawnContention
  )

  it.runIf(process.env.ORCA_GIT_ADMISSION_STORM_MEASUREMENT === '1')(
    'reports bounded-concurrency before and after measurements',
    async () => {
      const disabled = await measureStorm('disabled')
      const enabled = await measureStorm('enabled')
      console.info(`GIT_ADMISSION_STORM_MEASUREMENT=${formatMeasurementTable([disabled, enabled])}`)
      assertAdmissionLedger(enabled)
    }
  )
  // Real-git output parity remains in git-admission-output-parity.test.ts, including Windows.
})
