import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import type { runProcess } from '@orca/process-host'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import {
  installedManagedAgentCommand,
  noteLaunchReleasesRecorded,
  rememberManagedAgentRelease
} from '../../../managed-agent-cli/managed-agent-cli-registry'
import { provideInstalledManagedAgents } from '../../../preflight/managed-agent-detection'

function recordingRun(spawned: string[]): typeof runProcess {
  return async (spec) => {
    spawned.push(spec.program)
    const stdout = spec.args?.[0] === '--version' ? '1.5.15\n' : '{}'
    return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
  }
}

const hostProbe = {
  resolveEnvironment: async () => ({ PATH: '/usr/bin', HOME: '/home/me' }),
  credentialPresence: async () => 'present' as const,
  platform: 'darwin' as const,
  now: () => 0
}

// Installed as launch reclaim leaves it: recorded, and detection may run it.
function installManagedAgy(): string {
  provideInstalledManagedAgents(async () => ['antigravity'])
  rememberManagedAgentRelease('antigravity', join('/data', 'agent-runtimes', 'agy', '1.5.16'))
  noteLaunchReleasesRecorded()
  const managed = installedManagedAgentCommand('antigravity')
  if (!managed) {
    throw new Error("Orca's agy should be installed")
  }
  return managed
}

afterEach(() => {
  rememberManagedAgentRelease('antigravity', null)
  provideInstalledManagedAgents(async () => [])
})

it("finds Orca's agy on the first read after launch, before launch reclaim records it", async () => {
  provideInstalledManagedAgents(async () => ['antigravity'])
  const spawned: string[] = []
  const firstRead = fetchAntigravityRateLimits({
    ...hostProbe,
    runCommand: recordingRun(spawned),
    resolveCommand: async () => null
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(spawned).toEqual([])
  const managed = installManagedAgy()
  const limits = await firstRead
  expect(spawned).toEqual([managed, managed])
  expect(limits.usageMetadata?.failureKind).not.toBe('cli-unavailable')
})

it('hands the Settings proxy to the host agy usage probe', async () => {
  const spawnedEnvs: (NodeJS.ProcessEnv | undefined)[] = []
  const runCommand: typeof runProcess = async (spec) => {
    spawnedEnvs.push(spec.env)
    const stdout = spec.args?.[0] === '--version' ? '1.5.15\n' : '{}'
    return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
  }
  await fetchAntigravityRateLimits({
    runCommand,
    resolveCommand: async () => '/usr/local/bin/agy',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', NO_PROXY: 'corp.internal' }),
    platform: 'darwin',
    now: () => 0,
    networkProxySettings: {
      httpProxyUrl: 'http://proxy.example:3128',
      httpProxyBypassRules: 'localhost'
    }
  })
  const usageEnv = spawnedEnvs.at(-1)
  expect(usageEnv?.HTTPS_PROXY).toBe('http://proxy.example:3128')
  expect(usageEnv?.NO_PROXY).toBe('corp.internal,localhost')
  expect(usageEnv?.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true')
})

it("reads usage through Orca's agy when none is on PATH and agy holds a login", async () => {
  const managed = installManagedAgy()
  const homes: string[] = []
  const spawned: string[] = []
  await fetchAntigravityRateLimits({
    ...hostProbe,
    credentialPresence: async (home) => {
      homes.push(home)
      return 'present'
    },
    runCommand: recordingRun(spawned),
    resolveCommand: async () => null
  })
  expect(homes).toEqual(['/home/me'])
  expect(spawned).toEqual([managed, managed])
})

it("reads the user's own agy before Orca's copy", async () => {
  installManagedAgy()
  const spawned: string[] = []
  await fetchAntigravityRateLimits({
    ...hostProbe,
    runCommand: recordingRun(spawned),
    resolveCommand: async () => '/usr/local/bin/agy'
  })
  expect(spawned).toEqual(['/usr/local/bin/agy', '/usr/local/bin/agy'])
})

it("asks for sign-in instead of asking Orca's agy where agy holds no readable login", async () => {
  const managed = installManagedAgy()
  for (const [presence, failureKind] of [
    ['absent', 'missing-credentials'],
    ['locked', 'keychain-unavailable']
  ] as const) {
    const spawned: string[] = []
    const limits = await fetchAntigravityRateLimits({
      ...hostProbe,
      credentialPresence: async () => presence,
      runCommand: recordingRun(spawned),
      // Orca's copy on a PATH an Orca terminal passed on is not the user's own agy either.
      resolveCommand: async () => managed
    })
    expect(spawned).toEqual([])
    expect(limits.usageMetadata?.failureKind).toBe(failureKind)
    expect(limits.error).not.toMatch(/not found/)
  }
})

it("spawns nothing when agy is missing and Orca's copy is absent or switched off", async () => {
  const spawned: string[] = []
  const missing = await fetchAntigravityRateLimits({
    ...hostProbe,
    runCommand: recordingRun(spawned),
    resolveCommand: async () => null
  })
  const managed = installManagedAgy()
  // Detection leaves out a copy the antigravityManagedAgyEnabled kill switch turned off.
  provideInstalledManagedAgents(async () => [])
  const switchedOff = await fetchAntigravityRateLimits({
    ...hostProbe,
    runCommand: recordingRun(spawned),
    resolveCommand: async () => managed
  })
  expect(spawned).toEqual([])
  expect(missing.usageMetadata?.failureKind).toBe('cli-unavailable')
  expect(switchedOff.usageMetadata?.failureKind).toBe('cli-unavailable')
})
