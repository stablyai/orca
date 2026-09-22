// oxlint-disable anti-slop/no-module-mocking -- Exercise the CLI entrypoint without launching Docker.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync }))

const ready = {
  type: 'orca_server_ready',
  schemaVersion: 1,
  runtimeId: 'test-runtime',
  pairing: { url: 'orca://pair?code=test' }
}
const status = {
  reachable: true,
  runtime: {
    state: 'ready',
    runtimeId: ready.runtimeId,
    appVersion: '1.0.0',
    capabilities: ['updater.remote-control.v1'],
    remoteUpdateSupport: { automatic: false, reason: 'manual-service-update-required' }
  }
}

let directory
let artifact
let originalArgv
let failure
let clientRuns
let runCount
let cleanupFailures
const runningContainers = new Set()

function dockerResult(_, args) {
  if (args[0] === 'run') {
    const nameIndex = args.indexOf('--name')
    const name = nameIndex === -1 ? `anonymous-${runCount++}` : args[nameIndex + 1]
    runningContainers.add(name)
    if (args.includes('-d')) {
      if (failure === 'server-start') {
        throw new Error('lost detached launch response')
      }
      return name
    }
    if (args.includes('--pairing-code')) {
      clientRuns++
      if (failure === 'client-timeout') {
        throw Object.assign(new Error('client timed out'), { code: 'ETIMEDOUT', status: null })
      }
      runningContainers.delete(name)
      if (clientRuns === 2) {
        throw Object.assign(new Error('unreachable endpoint'), { status: 1 })
      }
      return JSON.stringify(status)
    }
    if (failure === 'extraction') {
      throw new Error('lost extraction response')
    }
    runningContainers.delete(name)
  }
  if (args[0] === 'logs') {
    return `${JSON.stringify(ready)}\n`
  }
  if (args[0] === 'rm') {
    if (failure === 'normal-removal' && !args.includes('-f')) {
      throw new Error('removal failed')
    }
    runningContainers.delete(args.at(-1))
  }
  if (['network', 'volume'].includes(args[0]) && args[1] === 'rm' && runningContainers.size) {
    cleanupFailures++
    throw new Error('resource is still in use')
  }
  return ''
}

async function run() {
  process.argv = ['node', 'runner', '--appimage', artifact, '--pairing-only']
  await import('./run-headless-linux-pairing-docker.mjs')
}

beforeEach(() => {
  vi.resetModules()
  execFileSync.mockReset().mockImplementation(dockerResult)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  directory = mkdtempSync(join(tmpdir(), 'orca-pairing-lifecycle-'))
  artifact = join(directory, 'test.AppImage')
  writeFileSync(artifact, 'fixture')
  originalArgv = process.argv
  failure = undefined
  clientRuns = 0
  runCount = 0
  cleanupFailures = 0
  runningContainers.clear()
})

afterEach(() => {
  process.argv = originalArgv
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('headless pairing container ownership', () => {
  it.each([
    ['client-timeout', 'pairing client failed'],
    ['server-start', 'lost detached launch response'],
    ['extraction', 'lost extraction response']
  ])('releases containers before shared resources after %s', async (scenario, message) => {
    failure = scenario
    await expect(run()).rejects.toThrow(message)
    expect([...runningContainers]).toEqual([])
    expect(cleanupFailures).toBe(0)
  })

  it('releases successful and failed pairing clients and each server', async () => {
    await run()
    expect(clientRuns).toBe(2)
    expect([...runningContainers]).toEqual([])
    expect(cleanupFailures).toBe(0)
  })

  it('retries failed removals without reusing a retained container name', async () => {
    failure = 'normal-removal'
    await run()
    const names = execFileSync.mock.calls
      .map(([, args]) => args)
      .filter((args) => args[0] === 'run')
      .map((args) => args[args.indexOf('--name') + 1])
    expect(new Set(names).size).toBe(names.length)
    expect([...runningContainers]).toEqual([])
    expect(cleanupFailures).toBe(0)
  })
})
