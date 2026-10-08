/**
 * The packaged orcad stops through its slot's stop-request file within the shutdown deadline.
 *
 * On Windows this is the only graceful stop: a signal there is TerminateProcess, which skips
 * the flush and leaves the instance lock. So every lane, Windows included, proves the real
 * server notices the file, shuts down cleanly (exit 0, lock released) before the 15 s
 * deadline, and published an instance lock carrying a real process start time.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import { ORCAD_NODE_RUNTIME_MARKER_FILENAME } from '../../shared/orcad-artifacts'
import { ORCAD_STOP_REQUEST_FILENAME } from '../../shared/orcad-stop-request'
import {
  killChildAndWait,
  killProfileDaemons,
  removeTestRoot
} from './orcad-daemon-teardown-fixture'
import { parseOrcadReadinessOutput } from '../ssh/orcad-remote-launch'
import { ORCAD_LOCK_FILE_NAME, readOrcadInstanceLockRecord } from './orcad-instance-lock'
import { ORCAD_SHUTDOWN_DEADLINE_MS } from './orcad-lifecycle'
import {
  installPackagedOrcadSlotForTests,
  locatePinnedNodeForTests,
  skipForMissingInputs
} from './orcad-node-slot-fixture'

const pinnedNode = locatePinnedNodeForTests()
const skip = skipForMissingInputs('artifact', [
  ...(pinnedNode ? [] : ['the pinned Node (ORCA_PINNED_NODE or out/runtimes)']),
  ...(existsSync(join('out/orcad', ORCAD_NODE_RUNTIME_MARKER_FILENAME))
    ? []
    : ['a Node orcad slot in out/orcad (pnpm build:orcad)'])
])

let root = ''
const children: ReturnType<typeof spawnProcess>[] = []

/** Without Vitest's markers: daemon-entry.js does not start its server under VITEST. */
function hostEnv(userData: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST') && key !== 'NODE_ENV')
    ),
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_DISABLE_MACOS_LOGIN_SHELL: '1',
    ORCA_VERSION: '0.0.0-stop-request-test',
    ORCA_USER_DATA: userData
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    await killChildAndWait(child)
  }
  if (root) {
    // The terminal daemon deliberately outlives orcad; it must be gone before its profile is.
    await killProfileDaemons(join(root, 'data'))
    await removeTestRoot(root)
  }
})

describe.skipIf(skip)('packaged orcad stop request', () => {
  it(`stops cleanly within ${ORCAD_SHUTDOWN_DEADLINE_MS} ms of its slot's stop-request file`, async () => {
    root = mkdtempSync(join(tmpdir(), 'orcad-stop-request-'))
    const { slotDir, runtime } = installPackagedOrcadSlotForTests(root, pinnedNode!)
    const userData = join(root, 'data')
    const launchedAt = Date.now()
    const child = spawnProcess({
      program: runtime,
      args: [join(slotDir, 'orcad.js'), '--json', '--bind', '127.0.0.1', '--port', '0'],
      cwd: slotDir,
      env: hostEnv(userData),
      timeoutMs: null
    })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))

    await vi.waitFor(
      () => {
        const parsed = parseOrcadReadinessOutput(stdout)
        if (parsed.state !== 'ready') {
          throw new Error(`orcad not ready (${parsed.state}): ${stderr.slice(-2000)}`)
        }
        expect(parsed.readiness.health?.stopRequests).toBe(1)
      },
      { timeout: 90_000, interval: 250 }
    )

    const lock = readOrcadInstanceLockRecord(join(userData, ORCAD_LOCK_FILE_NAME))
    expect(lock?.pid).toBe(child.pid)
    // Windows: the process-tree addon's creation time; POSIX: /proc or ps. Never null here.
    expect(lock?.startedAtMs).toEqual(expect.any(Number))
    expect(Math.abs(lock!.startedAtMs! - launchedAt)).toBeLessThan(30_000)

    const requestedAt = Date.now()
    writeFileSync(join(slotDir, ORCAD_STOP_REQUEST_FILENAME), '')
    const code = await exited
    const elapsedMs = Date.now() - requestedAt
    expect(code, stderr.slice(-2000)).toBe(0)
    // The listener polls once a second when the watcher misses the write.
    expect(elapsedMs).toBeLessThan(ORCAD_SHUTDOWN_DEADLINE_MS)
    expect(existsSync(join(userData, ORCAD_LOCK_FILE_NAME))).toBe(false)
    expect(existsSync(join(slotDir, ORCAD_STOP_REQUEST_FILENAME))).toBe(false)
  }, 150_000)
})
