import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from './single-instance-lock'

// Why #11935: the lock-loss gate runs before Electron `ready`, where `app.quit()` is deferred, so a
// duplicate headless `orca serve` kept executing the rest of startup, reached Linux Ozone/X11 init
// with no display, died with SIGSEGV, and systemd restarted it until the leaked AppImage FUSE mounts
// hit the kernel's 1000-mount ceiling. This runs the gate's own termination statement, lifted out of
// `src/main/index.ts`, under the real Electron binary.
//
// Why not a live lock race: Chromium's Linux ProcessSingleton only answers a second process once the
// browser IO thread is up, which needs `ready` and therefore a display. On a display-less CI runner
// the "owner" is treated as stale and the duplicate takes the lock, so the race cannot be staged
// there. Lock acquisition and argv forwarding are covered in `single-instance-lock.test.ts`; what
// only a real process can settle is what the loser does next, which is what this file pins.

const electronBinary = createRequire(import.meta.url)('electron') as string
const LOCK_LOST = 'LOCK_LOST'
const CONTINUED_INTO_STARTUP = 'CONTINUED_INTO_STARTUP'
const REACHED_TAIL = 'REACHED_TAIL'
const MARKER_ENV = 'ORCA_LOCK_FIXTURE_MARKER'

const fixtureRoots: string[] = []

afterAll(() => {
  for (const root of fixtureRoots) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

/** The `app.*` call the shipped lock-loss gate executes, so a revert to `app.quit()` fails here. */
function readLockLossTermination(): string {
  const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
  const start = source.indexOf('if (!hasSingleInstanceLock) {')
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n}', start)
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
    `mark('${LOCK_LOST}')`,
    termination,
    `mark('${CONTINUED_INTO_STARTUP}')`,
    // Why: stand in for the rest of `src/main/index.ts`, which on the reported host was display init.
    `mark('${REACHED_TAIL}')`,
    `process.exit(0)`
  ].join('\n')
}

type FixtureRun = { status: number | null; markers: string[] }

function runLockLossGate(termination: string): FixtureRun {
  const root = mkdtempSync(join(tmpdir(), 'orca-lock-loss-'))
  fixtureRoots.push(root)
  const dir = join(root, 'fixture')
  const marker = join(root, 'markers.log')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    '{ "name": "orca-lock-loss-fixture", "main": "main.js" }'
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

describe('#11935 pre-ready lock-loss termination under real Electron', () => {
  it('stops the duplicate launch before any further startup runs, with the already-running code', () => {
    const termination = readLockLossTermination()
    // Why: an empty slice would let the fixture fall through to its own exit and pass vacuously.
    expect(termination).not.toBe('')

    const run = runLockLossGate(termination)

    expect(run.markers).toEqual([LOCK_LOST])
    expect(run.status).toBe(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
  }, 90_000)

  it('reproduces the deferred graceful quit that let the doomed launch keep booting', () => {
    const run = runLockLossGate('app.quit()')

    // Why: pins the Electron semantic the fix rests on — pre-`ready` `quit()` schedules, it does not stop.
    expect(run.markers).toEqual([LOCK_LOST, CONTINUED_INTO_STARTUP, REACHED_TAIL])
    expect(run.status).not.toBe(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
  }, 90_000)
})
