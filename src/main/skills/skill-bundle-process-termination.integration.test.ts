import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { recoverPendingSkillTransactions } from './skill-transaction-startup-recovery'

const RUN_REAL_PROCESS = process.env.ORCA_REAL_PROCESS_SKILL_TEST === '1'
const require = createRequire(import.meta.url)
const vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const childTest = resolve('src/main/skills/skill-bundle-process-termination-child.test.ts')
const roots: string[] = []

function boundedOutput(child: ChildProcess): { value: () => string } {
  let output = ''
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-8_192)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return { value: () => output }
}

async function waitForPid(
  path: string,
  child: ChildProcess,
  output: () => string
): Promise<number> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
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
      // The synced marker may not be fully visible on its first read.
    }
    if (child.exitCode !== null) {
      throw new Error(`bundle-crash-child-exited-${child.exitCode}: ${output()}`)
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10))
  }
  throw new Error(`bundle-crash-marker-timeout: ${output()}`)
}

async function waitForActiveExtraction(stateDirectory: string): Promise<string> {
  const directory = join(stateDirectory, 'extraction-journals')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const names = await readdir(directory).catch(() => [])
    const journalName = names.find((name) => name.endsWith('.json'))
    if (journalName) {
      const journal = JSON.parse(await readFile(join(directory, journalName), 'utf8')) as {
        extractionPath?: unknown
      }
      if (typeof journal.extractionPath === 'string') {
        const entries = await readdir(journal.extractionPath).catch(() => [])
        if (entries.length > 0) {
          return journal.extractionPath
        }
      }
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5))
  }
  throw new Error('bundle-extraction-journal-timeout')
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
  throw new Error(`bundle-crash-process-still-running-${pid}`)
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('bundle-crash-coordinator-kill-failed')),
      5_000
    )
    child.once('exit', () => {
      clearTimeout(timeout)
      resolveExit()
    })
  })
}

async function startChild(root: string): Promise<{ child: ChildProcess; marker: string }> {
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
        ORCA_SKILL_BUNDLE_PROCESS_CHILD: '1',
        ORCA_SKILL_BUNDLE_CRASH_ROOT: root,
        ORCA_SKILL_BUNDLE_CRASH_MARKER: marker
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  return { child, marker }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(RUN_REAL_PROCESS)('skill bundle process termination recovery', () => {
  it('removes a partially extracted bundle and its durable journal after process death', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-bundle-process-crash-'))
    roots.push(root)
    const stateDirectory = join(root, 'state', 'skill-installs')
    const { child, marker } = await startChild(root)
    const output = boundedOutput(child)
    const transactionPid = await waitForPid(marker, child, output.value)
    const extractionPath = await waitForActiveExtraction(stateDirectory)

    process.kill(transactionPid, 'SIGKILL')
    await waitForProcessExit(transactionPid)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
    await waitForChildExit(child)

    expect(await stat(extractionPath)).toBeTruthy()
    const report = await recoverPendingSkillTransactions(stateDirectory)

    expect(report.failures).toEqual([])
    expect(report.orphanedExtractionsRecovered).toBe(1)
    await expect(stat(extractionPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(join(stateDirectory, 'extraction-journals'))).resolves.toEqual([])
    expect(
      (await readdir(join(root, 'home', '.agents', 'skills')).catch(() => [])).filter((name) =>
        name.includes('.orca-')
      )
    ).toEqual([])
  }, 45_000)
})
