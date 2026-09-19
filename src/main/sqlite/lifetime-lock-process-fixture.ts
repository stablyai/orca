import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest'
import {
  runProcess,
  spawnProcess,
  type SpawnedProcess
} from '../../shared/child-process/run-process'

export function installLifetimeLockProcessFixture(
  entryPoint: string,
  extraArgs: string[] = [],
  acquired: Record<string, unknown> = { transaction: true }
) {
  const children = new Set<SpawnedProcess>()
  let directory: string
  let entry: string
  let sequence = 0

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'orca-lifetime-lock-'))
    entry = join(directory, 'probe.cjs')
    await build({
      entryPoints: [resolve(entryPoint)],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs'
    })
  })

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
      await vi.waitFor(() =>
        expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
      )
    }
    children.clear()
  })

  afterAll(() => rmSync(directory, { recursive: true, force: true }))

  function createProfile() {
    const profile = join(directory, `profile-${sequence++}`)
    mkdirSync(profile)
    return profile
  }

  async function probe(runtime: string, path: string) {
    const result = await runProcess({
      program: runtime,
      args: [entry, path, 'probe', ...extraArgs],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 5000
    })
    expect(result.code, result.stderr).toBe(0)
    return JSON.parse(result.stdout.trim()) as { state: string; transaction?: boolean }
  }

  async function hold(runtime: string, path: string) {
    const child = spawnProcess({
      program: runtime,
      args: [entry, path, 'hold', ...extraArgs],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    children.add(child)
    let output = ''
    let diagnostic = ''
    child.stderr?.on('data', (data) => {
      diagnostic += String(data)
    })
    child.stdout?.on('data', (data) => {
      output += String(data)
    })
    const waitFor = async (state: string) => {
      await vi.waitFor(
        () => {
          expect(output, diagnostic).toContain(`"state":"${state}"`)
        },
        { timeout: 5000 }
      )
      return JSON.parse(
        output
          .trim()
          .split('\n')
          .find((line) => line.includes(`"state":"${state}"`))!
      )
    }
    expect(await waitFor('acquired')).toMatchObject(acquired)
    return { child, waitFor }
  }

  return {
    get directory() {
      return directory
    },
    createProfile,
    probe,
    hold
  }
}
