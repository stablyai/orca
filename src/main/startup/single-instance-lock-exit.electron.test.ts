import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from './single-instance-lock'

// Before-ready quit is deferred; execute shipped gate termination under real Electron. A live Linux lock race needs ready/display, so isolate loser exit semantics here; lock/argv tests cover ownership.

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
    // Use environment for markers because Chromium rewrites argv before main.
    `const marker = process.env.${MARKER_ENV}`,
    `const mark = (name) => appendFileSync(marker, name + '\\n')`,
    `const SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE = ${SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE}`,
    `mark('${GATE_ENTERED}')`,
    termination,
    `mark('${CONTINUED_INTO_STARTUP}')`,
    // Model startup tail that must not run after a fatal pre-ready gate.
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
    // Reject an empty source slice or the fixture's own exit passes vacuously.
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

    // Pin Electron semantics: pre-ready quit schedules exit but does not stop startup.
    expect(run.markers).toEqual([GATE_ENTERED, CONTINUED_INTO_STARTUP, REACHED_TAIL])
    expect(run.status).not.toBe(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
  }, 90_000)
})
