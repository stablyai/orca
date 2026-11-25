import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { findOwnAgentCli } = vi.hoisted(() => ({ findOwnAgentCli: vi.fn() }))

vi.mock('./agent-cli-own-install', () => ({ findOwnAgentCli }))
vi.mock('../native-chat/agent-model-catalog/agent-model-catalog-input-stamp', () => ({
  agentModelCatalogInputStamp: async () => 'launcher'
}))
vi.mock('../native-chat/agent-model-catalog/agent-model-catalog-store', () => ({
  agentModelCatalogStore: { expireLaunchScopes: () => {} }
}))
vi.mock('./agent-cli-latest-release', () => ({ latestAgentCliRelease: async () => '2.0.0' }))
vi.mock('./agent-cli-model-requirements', () => ({ readModelsNeedingCliUpdate: async () => [] }))

import { runAgentCliUpdate } from './agent-cli-update-service'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let dir = ''
afterEach(() => {
  vi.useRealTimers()
  // A failed run must not leave the fake updater behind.
  try {
    readFileSync(join(dir, 'pids'), 'utf8')
      .trim()
      .split(' ')
      .forEach((pid) => alive(Number(pid)) && process.kill(Number(pid), 'SIGKILL'))
  } catch {
    // It never started.
  }
  rmSync(dir, { recursive: true, force: true })
})

/** Runs the update through a fake `claude` whose update is `body`. */
async function runFakeUpdater(body: string) {
  dir = mkdtempSync(join(tmpdir(), 'agent-cli-update-timeout-'))
  const program = join(dir, 'claude')
  writeFileSync(
    program,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi',
      // A child that keeps the updater's output open for good.
      `sleep 100000 & echo "$$ $!" > '${join(dir, 'pids')}'`,
      body
    ].join('\n')
  )
  chmodSync(program, 0o755)
  findOwnAgentCli.mockResolvedValue({
    program,
    realPath: program,
    env: { PATH: process.env.PATH ?? '' },
    command: 'claude',
    version: { prefixArgs: [], env: { PATH: process.env.PATH ?? '' } }
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  let settled = false
  const run = runAgentCliUpdate('claude', {}).finally(() => {
    settled = true
  })
  // Steps the fake clock while the real processes answer in between.
  await vi.waitFor(
    async () => {
      await vi.advanceTimersByTimeAsync(1_000)
      expect(settled).toBe(true)
    },
    { timeout: 25_000, interval: 5 }
  )
  const [updater, child] = readFileSync(join(dir, 'pids'), 'utf8').trim().split(' ').map(Number)
  return { result: await run, updater, child }
}

describe('runAgentCliUpdate', () => {
  it.skipIf(process.platform === 'win32')(
    'stops an updater that goes silent and never exits, and fails the update',
    async () => {
      const { result, updater, child } = await runFakeUpdater('wait')
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.output).toContain('Stopped after 3 minutes without any output')
      expect(alive(updater)).toBe(false)
      expect(alive(child)).toBe(false)
    },
    30_000
  )

  it.skipIf(process.platform === 'win32')(
    'stops a child holding the updater’s output after the updater exits',
    async () => {
      const { result, child } = await runFakeUpdater('exit 0')
      expect(result.ok ? '' : result.output).toContain('left a process holding its output')
      expect(alive(child)).toBe(false)
    },
    30_000
  )
})
