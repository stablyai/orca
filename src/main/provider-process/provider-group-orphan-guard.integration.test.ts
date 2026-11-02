import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { ChildProcess } from 'node:child_process'
import { createProviderSpawnSpec } from './provider-process-supervisor'
import {
  guardSupervisedProviderGroup,
  type ProviderGroupSweepVerdict
} from './provider-group-orphan-guard'

// Leads its own group with a SIGTERM-ignoring grandchild, as a server with helpers would.
const PROVIDER = String.raw`
  const { spawn } = require('node:child_process')
  process.stdout.on('error', () => {})
  const grandchild = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 60000)"],
    { stdio: ['ignore', 'pipe', 'ignore'] }
  )
  grandchild.stdout.once('data', () =>
    process.stdout.write(JSON.stringify({ provider: process.pid, grandchild: grandchild.pid }) + '\n')
  )
  setInterval(() => {}, 60000)
`

const IDENTITY_TIMEOUT_MS = 15_000
const recordedPids = new Set<number>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return true
}

function launch(): {
  supervisor: ChildProcess
  proven: () => boolean
  swept: Promise<ProviderGroupSweepVerdict | 'unproven'>
  pids: Promise<{ provider: number; grandchild: number }>
} {
  const spec = createProviderSpawnSpec(
    { command: process.execPath, args: ['-e', PROVIDER] },
    process.env,
    process.platform,
    { lifetime: 'session' }
  )
  const supervisor = spawnProcess({
    program: spec.program,
    args: spec.args,
    env: spec.env,
    cwd: spec.cwd,
    detached: spec.detached,
    stdio: ['pipe', 'pipe', 'ignore', ...spec.groupReportStdio]
  })
  recordedPids.add(supervisor.pid!)
  let identityProven = false
  const swept = new Promise<ProviderGroupSweepVerdict | 'unproven'>((resolve) =>
    guardSupervisedProviderGroup(supervisor, {
      site: 'test',
      supervised: spec.supervised,
      onProven: () => {
        identityProven = true
      },
      onSwept: resolve
    })
  )
  const pids = new Promise<{ provider: number; grandchild: number }>((resolve) => {
    let buffered = ''
    supervisor.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      const line = buffered.split('\n')[0]
      if (buffered.includes('\n')) {
        const parsed = JSON.parse(line)
        recordedPids.add(parsed.provider)
        recordedPids.add(parsed.grandchild)
        resolve(parsed)
      }
    })
  })
  return { supervisor, proven: () => identityProven, swept, pids }
}

afterEach(() => {
  for (const pid of recordedPids) {
    if (alive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
  }
  recordedPids.clear()
})

describe.runIf(process.platform !== 'win32')('provider group orphan guard', () => {
  it('kills the provider group a SIGKILLed supervisor leaves behind', async () => {
    const { supervisor, proven, swept, pids } = launch()
    const { provider, grandchild } = await pids
    // Second-resolution start times require a reread after their second ends.
    expect(await waitFor(proven, IDENTITY_TIMEOUT_MS)).toBe(true)

    supervisor.kill('SIGKILL')

    await expect(swept).resolves.toBe('killed')
    expect(await waitFor(() => !alive(provider) && !alive(grandchild), 10_000)).toBe(true)
  })

  it('leaves nothing to sweep when the supervisor stops its own group', async () => {
    const { supervisor, proven, swept, pids } = launch()
    await pids
    expect(await waitFor(proven, IDENTITY_TIMEOUT_MS)).toBe(true)

    supervisor.kill('SIGTERM')

    await expect(swept).resolves.toBe('absent')
  })

  it('closes the report channel while the provider still runs', async () => {
    const { supervisor, pids } = launch()
    const disconnected = new Promise<void>((resolve) => supervisor.once('disconnect', resolve))
    const { provider } = await pids

    await disconnected
    expect(alive(provider)).toBe(true)
  })
})
