import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from './single-instance-lock'

// Why: `app.quit()` is deferred before Electron `ready`, so fatal startup gates must use the
// synchronous `app.exit()`. Run their shipped termination statements under the real binary.
//
// Why not a live lock race: Chromium's Linux ProcessSingleton only answers a second process once the
// browser IO thread is up, which needs `ready` and therefore a display. On a display-less CI runner
// the "owner" is treated as stale and the duplicate takes the lock, so the race cannot be staged
// there. Lock acquisition and argv forwarding are covered in `single-instance-lock.test.ts`; what
// only a real process can settle is what the loser does next, which is what this file pins.

const electronBinary = createRequire(import.meta.url)('electron') as string
const GATE_ENTERED = 'GATE_ENTERED'
const CONTINUED_INTO_STARTUP = 'CONTINUED_INTO_STARTUP'
const REACHED_TAIL = 'REACHED_TAIL'
const MARKER_ENV = 'ORCA_PRE_READY_EXIT_FIXTURE_MARKER'

const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

/** Read the `app.*` termination statement from a pre-ready gate in the shipped entrypoint. */
function readPreReadyTermination(gate: string): string {
  const source = readFileSync(
    join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
    'utf8'
  )
  const start = source.indexOf(gate)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n  }', start)
  expect(end).toBeGreaterThan(start)

  return source
    .slice(start, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('app.'))
    .join('\n')
}

function buildFixtureMain(termination: string): string {
  return [
    `const { app } = require('electron')`,
    `const { appendFileSync } = require('node:fs')`,
    // Why: the marker path travels by env — Chromium rewrites argv before the main script sees it.
    `const marker = process.env.${MARKER_ENV}`,
    `const mark = (name) => appendFileSync(marker, name + '\\n')`,
    `const SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE = ${SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE}`,
    `mark('${GATE_ENTERED}')`,
    termination,
    `mark('${CONTINUED_INTO_STARTUP}')`,
    // Why: stand in for the rest of `src/main/index.ts`, which on the reported host was display init.
    `mark('${REACHED_TAIL}')`,
    `process.exit(0)`
  ].join('\n')
}

type FixtureRun = { status: number | null; markers: string[] }

function runPreReadyGate(termination: string): FixtureRun {
  const root = mkdtempSync(join(tmpdir(), 'orca-pre-ready-exit-'))
  fixtureRoots.push(root)
  const dir = join(root, 'fixture')
  const marker = join(root, 'markers.log')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    '{ "name": "orca-pre-ready-exit-fixture", "main": "main.js" }'
  )
  writeFileSync(join(dir, 'main.js'), buildFixtureMain(termination))
  writeFileSync(marker, '')

  const result = spawnSync(electronBinary, [dir, '--no-sandbox'], {
    stdio: 'ignore',
    timeout: 60_000,
    env: { ...process.env, [MARKER_ENV]: marker }
  })
  expect(result.error).toBeUndefined()

  return {
    status: result.status,
    markers: readFileSync(marker, 'utf8').split('\n').filter(Boolean)
  }
}

describe('pre-ready termination under real Electron', () => {
  it('stops the duplicate launch before any further startup runs, with the already-running code', () => {
    const termination = readPreReadyTermination('if (!hasLock) {')
    // Why: an empty slice would let the fixture fall through to its own exit and pass vacuously.
    expect(termination).not.toBe('')

    const run = runPreReadyGate(termination)

    expect(run.markers).toEqual([GATE_ENTERED])
    expect(run.status).toBe(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
  }, 90_000)

  it('#17615 stops serve when display setup fails instead of entering Chromium startup', () => {
    const termination = readPreReadyTermination(
      'if (state.isServeMode && !state.headlessBrowserDisplayAvailable) {'
    )

    const run = runPreReadyGate(termination)

    expect(run.markers).toEqual([GATE_ENTERED])
    expect(run.status).toBe(1)
  }, 90_000)

  it('reproduces the deferred graceful quit that let the doomed launch keep booting', () => {
    const run = runPreReadyGate('app.quit()')

    // Why: pins the Electron semantic the fix rests on — pre-`ready` `quit()` schedules, it does not stop.
    expect(run.markers).toEqual([GATE_ENTERED, CONTINUED_INTO_STARTUP, REACHED_TAIL])
    expect(run.status).not.toBe(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
  }, 90_000)
})
