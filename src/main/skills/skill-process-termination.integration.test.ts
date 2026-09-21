import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSkillInstallReceipt } from './skill-install-provenance'
import { recoverPendingSkillTransactions } from './skill-transaction-startup-recovery'

const RUN_REAL_PROCESS = process.env.ORCA_REAL_PROCESS_SKILL_TEST === '1'
const require = createRequire(import.meta.url)
const vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const childTest = resolve('src/main/skills/skill-process-termination-child.test.ts')
const roots: string[] = []

type CrashCase = {
  operation: 'extract' | 'install' | 'remove'
  phase: string
  boundary: 'before' | 'after'
}

const cases: CrashCase[] = [
  { operation: 'extract', phase: 'partial-extraction', boundary: 'after' },
  ...['prepared', 'backup-created', 'canonical-placed', 'receipt-published', 'complete'].flatMap(
    (phase) =>
      (['before', 'after'] as const).map((boundary) => ({
        operation: 'install' as const,
        phase,
        boundary
      }))
  ),
  ...['prepared', 'moving', 'receipt-removed'].flatMap((phase) =>
    (['before', 'after'] as const).map((boundary) => ({
      operation: 'remove' as const,
      phase,
      boundary
    }))
  )
]

function boundedOutput(child: ChildProcess): { value: () => string } {
  let output = ''
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-8_192)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return { value: () => output }
}

async function waitForMarker(
  path: string,
  child: ChildProcess,
  output: () => string
): Promise<number> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await stat(path).catch(() => null)) {
      const marker = await readFile(path, 'utf8').catch(() => '')
      try {
        const parsed: unknown = JSON.parse(marker)
        const pid =
          parsed && typeof parsed === 'object' && 'pid' in parsed
            ? (parsed as { pid?: unknown }).pid
            : null
        if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
          return pid
        }
      } catch {
        // The marker may be visible before its synced write completes.
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`crash-child-exited-${child.exitCode}: ${output()}`)
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(`crash-child-marker-timeout: ${output()}`)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) {
      return
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(`crash-transaction-process-still-running-${pid}`)
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true
  }
  return new Promise<boolean>((resolveExit) => {
    const timeout = setTimeout(() => resolveExit(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolveExit(true)
    })
  })
}

async function terminateAtBoundary(root: string, crashCase: CrashCase): Promise<void> {
  const marker = join(root, 'crash-ready')
  const child = spawn(
    process.execPath,
    [
      vitestBin,
      'run',
      '--config',
      resolve('config/vitest.config.ts'),
      '--pool=forks',
      '--maxWorkers=1',
      '--no-file-parallelism',
      childTest
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ORCA_REAL_PROCESS_SKILL_TEST: '0',
        ORCA_SKILL_PROCESS_CHILD: '1',
        ORCA_SKILL_CRASH_ROOT: root,
        ORCA_SKILL_CRASH_MARKER: marker,
        ORCA_SKILL_CRASH_OPERATION: crashCase.operation,
        ORCA_SKILL_CRASH_PHASE: crashCase.phase,
        ORCA_SKILL_CRASH_BOUNDARY: crashCase.boundary
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  const output = boundedOutput(child)
  const transactionPid = await waitForMarker(marker, child, output.value)
  let transactionError: unknown = null
  try {
    process.kill(transactionPid, 'SIGKILL')
    await waitForProcessExit(transactionPid)
  } catch (error) {
    transactionError = error
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error(`crash-coordinator-kill-failed: ${output.value()}`)
  }
  if (transactionError) {
    throw transactionError
  }
  if (processIsAlive(transactionPid)) {
    throw new Error(`crash-transaction-kill-failed-${transactionPid}: ${output.value()}`)
  }
}

async function directoryIsEmpty(path: string): Promise<boolean> {
  return (await readdir(path).catch(() => [])).length === 0
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(RUN_REAL_PROCESS)('skill process termination recovery', () => {
  it.each(cases)(
    'recovers $operation $phase $boundary process death',
    async (crashCase) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-skill-process-crash-'))
      roots.push(root)
      await terminateAtBoundary(root, crashCase)

      const stateDirectory = join(root, 'state')
      const canonicalPath = join(root, 'skills', 'crash-skill')
      const report = await recoverPendingSkillTransactions(stateDirectory)
      const receipt = await readSkillInstallReceipt(stateDirectory, canonicalPath)
      const markdown = await readFile(join(canonicalPath, 'SKILL.md'), 'utf8').catch(() => null)

      expect(report.failures).toEqual([])
      expect(Boolean(receipt)).toBe(Boolean(markdown))
      if (markdown) {
        expect(markdown).toContain(receipt?.versionId === 'version_2' ? '# Second' : '# First')
      }
      for (const directory of ['journals', 'removal-journals', 'extraction-journals', 'locks']) {
        expect(await directoryIsEmpty(join(stateDirectory, directory)), directory).toBe(true)
      }
      expect(
        (await readdir(join(root, 'skills')).catch(() => [])).filter((name) =>
          name.includes('.orca-')
        )
      ).toEqual([])
    },
    30_000
  )
})
