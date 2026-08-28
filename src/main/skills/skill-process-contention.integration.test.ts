import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSkillPackageArchive } from './skill-package-creation'

const RUN_REAL_PROCESS = process.env.ORCA_REAL_PROCESS_SKILL_TEST === '1'
const require = createRequire(import.meta.url)
const vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const childTest = resolve('src/main/skills/skill-process-contention-child.test.ts')
const roots: string[] = []
const children: ChildProcess[] = []

function childOutput(child: ChildProcess): { value(): string } {
  let output = ''
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString('utf8')}`.slice(-8_192)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  return { value: () => output }
}

async function waitForFile(path: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await stat(path).catch(() => null)) {
      return
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `skill-contention-child-exited-${child.exitCode ?? child.signalCode}: ${output()}`
      )
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20))
  }
  throw new Error(`skill-contention-marker-timeout: ${output()}`)
}

function startChild(input: {
  root: string
  archivePath: string
  role: 'holder' | 'blocked' | 'retry'
  readyPath: string
  releasePath: string
  resultPath: string
}): { child: ChildProcess; output: () => string } {
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
        ORCA_SKILL_CONTENTION_CHILD: '1',
        ORCA_SKILL_CONTENTION_ROOT: input.root,
        ORCA_SKILL_CONTENTION_ARCHIVE: input.archivePath,
        ORCA_SKILL_CONTENTION_ROLE: input.role,
        ORCA_SKILL_CONTENTION_READY: input.readyPath,
        ORCA_SKILL_CONTENTION_RELEASE: input.releasePath,
        ORCA_SKILL_CONTENTION_RESULT: input.resultPath
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  children.push(child)
  return { child, output: childOutput(child).value }
}

async function waitForExit(child: ChildProcess, output: () => string): Promise<void> {
  const exit =
    child.exitCode !== null || child.signalCode !== null
      ? { code: child.exitCode, signal: child.signalCode }
      : await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolveExit, rejectExit) => {
            const timeout = setTimeout(() => {
              child.kill('SIGKILL')
              rejectExit(new Error(`skill-contention-child-timeout: ${output()}`))
            }, 15_000)
            child.once('error', (error) => {
              clearTimeout(timeout)
              rejectExit(error)
            })
            child.once('exit', (code, signal) => {
              clearTimeout(timeout)
              resolveExit({ code, signal })
            })
          }
        )
  if (exit.code !== 0) {
    throw new Error(`skill-contention-child-failed-${exit.code ?? exit.signal}: ${output()}`)
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe.runIf(RUN_REAL_PROCESS)('skill multi-process contention', () => {
  it('fails busy without residue, then converges after the owner releases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-skill-process-contention-'))
    roots.push(root)
    const source = join(root, 'source')
    await mkdir(source)
    await writeFile(
      join(source, 'SKILL.md'),
      '---\nname: contention-skill\ndescription: Contention\n---\n\n# Contention\n'
    )
    const archive = await createSkillPackageArchive({
      sourceDirectory: source,
      archivePath: join(root, 'package.tar.gz'),
      packageId: 'package-contention',
      versionId: 'version_1'
    })
    const readyPath = join(root, 'holder-ready')
    const releasePath = join(root, 'holder-release')
    const holderResultPath = join(root, 'holder-result.json')
    const blockedResultPath = join(root, 'blocked-result.json')
    const retryResultPath = join(root, 'retry-result.json')
    const holder = startChild({
      root,
      archivePath: archive.archivePath,
      role: 'holder',
      readyPath,
      releasePath,
      resultPath: holderResultPath
    })
    await waitForFile(readyPath, holder.child, holder.output)

    const blocked = startChild({
      root,
      archivePath: archive.archivePath,
      role: 'blocked',
      readyPath,
      releasePath,
      resultPath: blockedResultPath
    })
    await waitForExit(blocked.child, blocked.output)
    expect(JSON.parse(await readFile(blockedResultPath, 'utf8'))).toMatchObject({
      status: 'failed',
      errorCategory: 'skill-install-busy',
      failure: { retryable: true }
    })

    await writeFile(releasePath, 'release\n')
    await waitForExit(holder.child, holder.output)
    expect(JSON.parse(await readFile(holderResultPath, 'utf8'))).toMatchObject({
      status: 'installed'
    })

    const retry = startChild({
      root,
      archivePath: archive.archivePath,
      role: 'retry',
      readyPath,
      releasePath,
      resultPath: retryResultPath
    })
    await waitForExit(retry.child, retry.output)
    expect(JSON.parse(await readFile(retryResultPath, 'utf8'))).toMatchObject({
      status: 'unchanged'
    })
    expect(await readdir(join(root, 'state', 'receipts'))).toHaveLength(1)
    expect((await readdir(join(root, 'skills'))).filter((name) => name.includes('.orca-'))).toEqual(
      []
    )
  }, 30_000)
})
