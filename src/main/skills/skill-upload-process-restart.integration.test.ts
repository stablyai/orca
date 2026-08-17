import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillUploadSessionService } from './skill-upload-session-service'

const RUN_REAL_PROCESS = process.env.ORCA_REAL_PROCESS_SKILL_TEST === '1'
const require = createRequire(import.meta.url)
const vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const childTest = resolve('src/main/skills/skill-upload-process-restart-child.test.ts')
const roots: string[] = []
const children: ChildProcess[] = []
const bytes = Buffer.from('upload process restart package')

function identity() {
  return {
    packageId: 'package_restart',
    versionId: 'version_restart',
    packageDigest: 'a'.repeat(64),
    archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    compressedBytes: bytes.length
  }
}

function boundedOutput(child: ChildProcess): () => string {
  let output = ''
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-8_192)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return () => output
}

async function waitForMarker(path: string, child: ChildProcess, output: () => string) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await stat(path).catch(() => null)) {
      const marker = await readFile(path, 'utf8').catch(() => '')
      try {
        const parsed = JSON.parse(marker) as { pid?: unknown; uploadId?: unknown }
        if (
          typeof parsed.pid === 'number' &&
          Number.isInteger(parsed.pid) &&
          parsed.pid > 0 &&
          typeof parsed.uploadId === 'string'
        ) {
          return { pid: parsed.pid, uploadId: parsed.uploadId }
        }
      } catch {
        // The marker may be visible before its synced write completes.
      }
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`upload-child-exited: ${output()}`)
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(`upload-child-marker-timeout: ${output()}`)
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('upload-process-exit-timeout'))
    }, 5_000)
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', () => {
      clearTimeout(timeout)
      resolveExit()
    })
  })
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
  throw new Error(`upload-process-still-running-${pid}`)
}

async function terminateUpload(root: string, boundary: string): Promise<string> {
  const marker = join(root, 'restart-ready')
  const uploadRoot = join(root, 'uploads')
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
        ORCA_SKILL_UPLOAD_PROCESS_CHILD: '1',
        ORCA_SKILL_UPLOAD_RESTART_ROOT: uploadRoot,
        ORCA_SKILL_UPLOAD_RESTART_MARKER: marker,
        ORCA_SKILL_UPLOAD_RESTART_BOUNDARY: boundary
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  children.push(child)
  const output = boundedOutput(child)
  const stopped = await waitForMarker(marker, child, output)
  process.kill(stopped.pid, 'SIGKILL')
  await waitForProcessExit(stopped.pid)
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
  await waitForExit(child)
  return stopped.uploadId
}

async function completeFreshTransfer(uploadRoot: string): Promise<void> {
  const service = new SkillUploadSessionService(uploadRoot)
  const begun = await service.begin({ package: identity(), transferId: 'operation-fresh' })
  expect(await readdir(uploadRoot)).toEqual([`${begun.uploadId}.tar.gz`])
  await service.append({
    uploadId: begun.uploadId,
    offset: 0,
    bytesBase64: bytes.toString('base64')
  })
  await service.commit(begun.uploadId)
  const taken = await service.take(begun.uploadId, identity())
  expect(await readFile(taken.archivePath)).toEqual(bytes)
  await taken.cleanup()
  expect(await readdir(uploadRoot)).toEqual([])
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(RUN_REAL_PROCESS)('skill upload process restart recovery', () => {
  it.each(['begun', 'partial', 'uploaded', 'committed'])(
    'cleans and replaces a %s upload after host process death',
    async (boundary) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-skill-upload-restart-'))
      roots.push(root)
      const uploadRoot = join(root, 'uploads')
      const abandonedId = await terminateUpload(root, boundary)

      expect(await readdir(uploadRoot)).toEqual([`${abandonedId}.tar.gz`])
      await completeFreshTransfer(uploadRoot)
    },
    30_000
  )
})
