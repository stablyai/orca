import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  shouldActivateDesktopForSecondInstance,
  SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
} from './single-instance-lock'

// Why #11935: two real Electron processes against one profile, because the reported crash loop only
// exists on the loser of a genuine lock race. Pre-`ready` `app.quit()` is deferred, so that loser kept
// executing the rest of startup, reached Linux Ozone/X11 init with no display, died with SIGSEGV, and
// systemd restarted it until the leaked AppImage FUSE mounts hit the kernel's 1000-mount ceiling.
// The duplicate runs the lock-loss gate's own termination statement, lifted out of `src/main/index.ts`.

const electronBinary = createRequire(import.meta.url)('electron') as string
const OWNER_ACQUIRED = 'OWNER_ACQUIRED'
const DUPLICATE_LOST_LOCK = 'DUPLICATE_LOST_LOCK'
const DUPLICATE_CONTINUED_INTO_STARTUP = 'DUPLICATE_CONTINUED_INTO_STARTUP'
const SECOND_INSTANCE_ARGV = 'SECOND_INSTANCE_ARGV '

// Why: the marker path travels by env, not argv — Chromium rewrites argv, and the duplicate's argv is
// itself under test.
const OWNER_MAIN = `const { app } = require('electron')
const { appendFileSync } = require('node:fs')
const marker = process.env.ORCA_LOCK_FIXTURE_MARKER
app.on('second-instance', (_event, argv) => {
  appendFileSync(marker, '${SECOND_INSTANCE_ARGV}' + JSON.stringify(argv) + '\\n')
})
appendFileSync(marker, app.requestSingleInstanceLock() ? '${OWNER_ACQUIRED}\\n' : 'OWNER_LOST\\n')
// Why: outlive the duplicate without reaching \`ready\`, which needs a display CI does not have.
setTimeout(() => process.exit(0), 120_000)
`

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

function buildDuplicateMain(termination: string): string {
  return [
    `const { app } = require('electron')`,
    `const { appendFileSync } = require('node:fs')`,
    `const marker = process.env.ORCA_LOCK_FIXTURE_MARKER`,
    `const SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE = ${SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE}`,
    `const hasSingleInstanceLock = app.requestSingleInstanceLock()`,
    `if (hasSingleInstanceLock) { appendFileSync(marker, 'DUPLICATE_WON_LOCK\\n'); process.exit(0) }`,
    `appendFileSync(marker, '${DUPLICATE_LOST_LOCK}\\n')`,
    termination,
    `appendFileSync(marker, '${DUPLICATE_CONTINUED_INTO_STARTUP}\\n')`,
    // Why: the deferred-quit control must stop here rather than boot on into display init.
    `process.exit(0)`
  ].join('\n')
}

function writeFixture(root: string, name: string, main: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `{ "name": "${name}", "main": "main.js" }`)
  writeFileSync(join(dir, 'main.js'), main)
  return dir
}

let root = ''
let profile = ''
let ownerMarker = ''
let owner: ChildProcess | null = null

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean)
}

function readForwardedArgvLines(): string[] {
  return readLines(ownerMarker).filter((line) => line.startsWith(SECOND_INSTANCE_ARGV))
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-single-instance-'))
  profile = join(root, 'profile')
  ownerMarker = join(root, 'owner.log')
  writeFileSync(ownerMarker, '')
  const ownerDir = writeFixture(root, 'owner', OWNER_MAIN)

  owner = spawn(electronBinary, [ownerDir, `--user-data-dir=${profile}`, '--no-sandbox'], {
    stdio: 'ignore',
    env: { ...process.env, ORCA_LOCK_FIXTURE_MARKER: ownerMarker }
  })
  await waitFor(() => readLines(ownerMarker).includes(OWNER_ACQUIRED), 'the owner to take the lock')
}, 90_000)

afterAll(async () => {
  if (owner && owner.exitCode === null) {
    const exited = new Promise<void>((resolve) => {
      owner?.once('exit', () => resolve())
    })
    owner.kill('SIGKILL')
    await exited
  }
  // Why: Windows keeps the profile's handles open for a beat after the kill, which fails an immediate rm.
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

type DuplicateRun = { status: number | null; markers: string[]; ownerSawArgv: string[] }

// Why: only the activation case needs the owner's notification, so the exit-contract cases do not
// hang on it — they are about the duplicate's own process, which has already terminated by here.
async function launchDuplicate(
  termination: string,
  argv: string[],
  awaitOwnerNotification = false
): Promise<DuplicateRun> {
  const name = `duplicate-${Math.random().toString(36).slice(2)}`
  const dir = writeFixture(root, name, buildDuplicateMain(termination))
  const marker = join(root, `${name}.log`)
  writeFileSync(marker, '')
  const seen = readForwardedArgvLines().length

  const result = spawnSync(
    electronBinary,
    [dir, `--user-data-dir=${profile}`, '--no-sandbox', ...argv],
    {
      stdio: 'ignore',
      timeout: 60_000,
      env: { ...process.env, ORCA_LOCK_FIXTURE_MARKER: marker }
    }
  )
  expect(result.error).toBeUndefined()
  if (awaitOwnerNotification) {
    await waitFor(
      () => readForwardedArgvLines().length > seen,
      'the owner to receive the second-instance notification'
    )
  }

  const latest = readForwardedArgvLines().at(-1)
  return {
    status: result.status,
    markers: readLines(marker),
    ownerSawArgv: latest ? (JSON.parse(latest.slice(SECOND_INSTANCE_ARGV.length)) as string[]) : []
  }
}

describe('#11935 duplicate headless serve against a live owner', () => {
  it('exits the duplicate before any further startup runs, leaving the owner untouched', async () => {
    const termination = readLockLossTermination()
    // Why: an empty slice would let the fixture fall through to its own exit and pass vacuously.
    expect(termination).not.toBe('')

    const run = await launchDuplicate(termination, ['--serve'])

    expect(run.markers).toContain(DUPLICATE_LOST_LOCK)
    // Why: this is where the reported host continued into Ozone/X11 init and SIGSEGV'd into the restart loop.
    expect(run.markers).not.toContain(DUPLICATE_CONTINUED_INTO_STARTUP)
    expect(run.status).toBe(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
    expect(owner?.exitCode).toBeNull()
  }, 90_000)

  it('hands the owner a real argv that suppresses desktop activation only for serve', async () => {
    const serveRun = await launchDuplicate(readLockLossTermination(), ['--serve'], true)
    expect(serveRun.ownerSawArgv).toContain('--serve')
    expect(shouldActivateDesktopForSecondInstance(serveRun.ownerSawArgv)).toBe(false)

    const desktopRun = await launchDuplicate(readLockLossTermination(), [], true)
    expect(desktopRun.ownerSawArgv).not.toContain('--serve')
    expect(shouldActivateDesktopForSecondInstance(desktopRun.ownerSawArgv)).toBe(true)
  }, 90_000)

  it('reproduces the deferred graceful quit that let the doomed launch keep booting', async () => {
    const run = await launchDuplicate('app.quit()', ['--serve'])

    // Why: pins the Electron semantic the fix rests on — pre-`ready` `quit()` schedules, it does not stop.
    expect(run.markers).toEqual([DUPLICATE_LOST_LOCK, DUPLICATE_CONTINUED_INTO_STARTUP])
    expect(run.status).not.toBe(SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE)
  }, 90_000)
})
