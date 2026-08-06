import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const cleanupPaths: string[] = []
const tripwireScriptPath = path.resolve('config/scripts/codex-primary-home-tripwire.mjs')
const tripwireModuleUrl = pathToFileURL(tripwireScriptPath).href
// Why: native Windows process startup can exceed two seconds under a loaded test worker.
const STANDALONE_START_TIMEOUT_MS = 10_000

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((cleanupPath) => rm(cleanupPath, { recursive: true }))
  )
})

async function createPrimaryHome(): Promise<string> {
  const primaryHome = await mkdtemp(path.join(os.tmpdir(), 'orca-codex-tripwire-'))
  cleanupPaths.push(primaryHome)
  await mkdir(path.join(primaryHome, '.codex'))
  return primaryHome
}

describe('Codex primary-home tripwire', () => {
  it('keeps the standalone monitor alive until it is stopped', async () => {
    const primaryHome = await createPrimaryHome()
    const child = spawn(process.execPath, [tripwireScriptPath, '--primary-home', primaryHome], {
      stdio: ['ignore', 'pipe', 'pipe']
    })

    try {
      await waitForStdout(child, '[CODEX HOME TRIPWIRE] Watching')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill()
    }
  })

  it('detects a write without reading file contents', async () => {
    const primaryHome = await createPrimaryHome()
    const status = runTripwireModule<{
      clean: boolean
      events: { changedPaths: string[] }[]
    }>(
      `
        import path from 'node:path'
        import { writeFile } from 'node:fs/promises'
        const { startCodexPrimaryHomeTripwire } = await import(process.argv[1])
        const tripwire = await startCodexPrimaryHomeTripwire({
          primaryHome: process.argv[2],
          intervalMs: 25
        })
        await writeFile(path.join(process.argv[2], '.codex', 'hooks.json'), '{"secret":"not-read"}\\n')
        await tripwire.scan()
        console.log(JSON.stringify(await tripwire.stop()))
      `,
      [primaryHome]
    )
    expect(status.clean).toBe(false)
    expect(status.events[0].changedPaths).toContain('hooks.json')
    expect(JSON.stringify(status)).not.toContain('not-read')
  })

  // Why: ordinary Windows CI tokens cannot create file symlinks without Developer Mode.
  it.skipIf(process.platform === 'win32')(
    'does not follow symlinks outside the watched home',
    async () => {
      const primaryHome = await createPrimaryHome()
      const externalRoot = await mkdtemp(path.join(os.tmpdir(), 'orca-codex-tripwire-external-'))
      cleanupPaths.push(externalRoot)
      const externalFile = path.join(externalRoot, 'credential.txt')
      await writeFile(externalFile, 'before')
      await symlink(externalFile, path.join(primaryHome, '.codex', 'linked-credential'))
      const codexHome = path.join(primaryHome, '.codex')
      const before = snapshotCodexHome(codexHome)

      await writeFile(externalFile, 'after-with-a-different-size')
      const after = snapshotCodexHome(codexHome)

      expect(after.digest).toBe(before.digest)
    }
  )
})

function runTripwireModule<T>(source: string, args: string[]): T {
  const stdout = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', source, tripwireModuleUrl, ...args],
    { encoding: 'utf8' }
  )
  return JSON.parse(stdout.trim()) as T
}

function snapshotCodexHome(codexHome: string): { digest: string } {
  return runTripwireModule<{ digest: string }>(
    `
      const { snapshotCodexHome } = await import(process.argv[1])
      console.log(JSON.stringify(await snapshotCodexHome(process.argv[2])))
    `,
    [codexHome]
  )
}

function waitForStdout(child: ReturnType<typeof spawn>, expectedText: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expectedText}`)),
      STANDALONE_START_TIMEOUT_MS
    )
    let output = ''
    const stdout = child.stdout
    if (!stdout) {
      clearTimeout(timeout)
      reject(new Error('Tripwire child stdout is unavailable'))
      return
    }
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes(expectedText)) {
        clearTimeout(timeout)
        resolve()
      }
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`Tripwire exited early with code ${code}`))
    })
  })
}

describe('lane-aware tripwire event classification', () => {
  it('separates designed system-default churn from containment violations', () => {
    const verdicts = runTripwireModule<string[]>(
      `
        const { classifyCodexHomeTripwireEvent } = await import(process.argv[1])
        const cases = [
          { changedPaths: ['.', 'goals_1.sqlite', 'logs_2.sqlite-wal', 'state_5.sqlite-shm', 'memories_1.sqlite-journal', 'tmp', 'tmp/arg0', 'tmp\\\\arg0', 'log', 'log/codex-tui.log'] },
          { changedPaths: ['.'] },
          { changedPaths: ['.', 'auth.json'] },
          { changedPaths: ['auth.json'] },
          { changedPaths: ['config.toml'] },
          { changedPaths: ['.credentials.json'] },
          { changedPaths: ['hooks.json'] },
          { changedPaths: ['sessions/2026/07/rollout-x.jsonl'] },
          { changedPaths: ['skills/SKILL.md'] },
          { changedPaths: ['unknown-file.bin'] },
          { changedPaths: ['goals_1.sqlite', 'auth.json'] },
          { changedPaths: ['sessions/index.sqlite-wal'] },
          { scanError: 'boom', changedPaths: [] },
          {}
        ]
        console.log(JSON.stringify(cases.map((tripwireEvent) => classifyCodexHomeTripwireEvent(tripwireEvent))))
      `,
      []
    )
    expect(verdicts).toEqual([
      'designed-system-default',
      'designed-system-default',
      'violation',
      'violation',
      'violation',
      'violation',
      'violation',
      'violation',
      'violation',
      'violation',
      'violation',
      'violation',
      'violation',
      'violation'
    ])
  })
})
