import { afterEach, expect, it } from 'vitest'
import { resolve } from 'node:path'
import type { runProcess } from '@orca/process-host'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import {
  installedManagedAgentCommand,
  noteLaunchReleasesRecorded,
  rememberManagedAgentRelease
} from '../../../managed-agent-cli/managed-agent-cli-registry'
import { provideInstalledManagedAgents } from '../../../preflight/managed-agent-detection'
import { setDefaultProxySessionResolver } from '../../../network/electron-default-proxy-session'

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
  rememberManagedAgentRelease('antigravity', resolve('/data', 'agent-runtimes', 'agy', '1.5.16'))
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
  setDefaultProxySessionResolver(null)
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

const VALID_USAGE_JSON = JSON.stringify({
  status: 'SUCCESS',
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini',
          buckets: [{ id: 'gemini-5h', name: '5h', window: '5h', remaining_fraction: 0.75 }]
        }
      ]
    }
  }
})

it('resolves and injects the OS system proxy when neither shell env nor Settings proxy is set', async () => {
  const probedUrls: string[] = []
  setDefaultProxySessionResolver(() => ({
    resolveProxy: async (url) => {
      probedUrls.push(url)
      return 'PROXY 127.0.0.1:7897'
    },
    setProxy: async () => {}
  }))
  const spawnedEnvs: (NodeJS.ProcessEnv | undefined)[] = []
  const runCommand: typeof runProcess = async (spec) => {
    spawnedEnvs.push(spec.env)
    const stdout = spec.args?.[0] === '--version' ? '1.5.15\n' : VALID_USAGE_JSON
    return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
  }

  const limits = await fetchAntigravityRateLimits({
    runCommand,
    resolveCommand: async () => '/usr/local/bin/agy',
    resolveEnvironment: async () => ({ PATH: '/usr/bin', NO_PROXY: 'corp.internal' }),
    platform: 'darwin',
    now: () => 0
  })

  expect(probedUrls).toEqual(['https://daily-cloudcode-pa.googleapis.com'])
  expect(limits.status).toBe('ok')
  expect(spawnedEnvs.at(-1)).toMatchObject({
    HTTPS_PROXY: 'http://127.0.0.1:7897',
    HTTP_PROXY: 'http://127.0.0.1:7897',
    ALL_PROXY: 'http://127.0.0.1:7897',
    NO_PROXY: 'corp.internal',
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true'
  })
})

it('retries directly when a resolved OS system proxy fails with 407 proxy auth', async () => {
  setDefaultProxySessionResolver(() => ({
    resolveProxy: async () => 'PROXY 127.0.0.1:8080',
    setProxy: async () => {}
  }))
  const usageEnvs: (NodeJS.ProcessEnv | undefined)[] = []
  const usageTimeouts: (number | null | undefined)[] = []
  let nowMs = 0
  const runCommand: typeof runProcess = async (spec) => {
    if (spec.args?.[0] === '--version') {
      return { code: 0, signal: null, stdout: '1.5.15\n', stderr: '', timedOut: false }
    }
    usageEnvs.push(spec.env)
    usageTimeouts.push(spec.timeoutMs)
    if (usageEnvs.length === 1) {
      nowMs = 29_500
      return {
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'HTTP 407 Proxy Authentication Required',
        timedOut: false
      }
    }
    return { code: 0, signal: null, stdout: VALID_USAGE_JSON, stderr: '', timedOut: false }
  }

  const limits = await fetchAntigravityRateLimits({
    runCommand,
    resolveCommand: async () => '/usr/local/bin/agy',
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    platform: 'darwin',
    now: () => nowMs
  })

  expect(limits.status).toBe('ok')
  expect(limits.session?.usedPercent).toBe(25)
  expect(usageEnvs.map((env) => env?.HTTPS_PROXY)).toEqual(['http://127.0.0.1:8080', undefined])
  expect(usageTimeouts).toEqual([30_000, 1_000])

  const controller = new AbortController()
  const abortedEnvs: (NodeJS.ProcessEnv | undefined)[] = []
  const aborted = await fetchAntigravityRateLimits({
    runCommand: async (spec) => {
      if (spec.args?.[0] === '--version') {
        return { code: 0, signal: null, stdout: '1.5.15\n', stderr: '', timedOut: false }
      }
      abortedEnvs.push(spec.env)
      controller.abort()
      return {
        code: 1,
        signal: null,
        stdout: '',
        stderr: 'HTTP 407 Proxy Authentication Required',
        timedOut: false
      }
    },
    resolveCommand: async () => '/usr/local/bin/agy',
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    platform: 'darwin',
    signal: controller.signal,
    now: () => 0
  })

  expect(aborted.status).toBe('unavailable')
  expect(abortedEnvs.map((env) => env?.HTTPS_PROXY)).toEqual(['http://127.0.0.1:8080'])
})

it('retries directly only when a failed PAC proxy has a DIRECT fallback', async () => {
  setDefaultProxySessionResolver(() => ({
    resolveProxy: async () => 'PROXY 127.0.0.1:9999; DIRECT',
    setProxy: async () => {}
  }))
  const usageEnvsWithDirect: (NodeJS.ProcessEnv | undefined)[] = []
  const runWithDirect: typeof runProcess = async (spec) => {
    if (spec.args?.[0] === '--version') {
      return { code: 0, signal: null, stdout: '1.5.15\n', stderr: '', timedOut: false }
    }
    usageEnvsWithDirect.push(spec.env)
    return usageEnvsWithDirect.length === 1
      ? {
          code: 1,
          signal: null,
          stdout: '',
          stderr: 'proxyconnect tcp: dial tcp 127.0.0.1:9999: connect: connection refused',
          timedOut: false
        }
      : { code: 0, signal: null, stdout: VALID_USAGE_JSON, stderr: '', timedOut: false }
  }

  const recovered = await fetchAntigravityRateLimits({
    runCommand: runWithDirect,
    resolveCommand: async () => '/usr/local/bin/agy',
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    platform: 'darwin',
    now: () => 0
  })

  expect(recovered.status).toBe('ok')
  expect(usageEnvsWithDirect.map((env) => env?.HTTPS_PROXY)).toEqual([
    'http://127.0.0.1:9999',
    undefined
  ])

  setDefaultProxySessionResolver(() => ({
    resolveProxy: async () => 'PROXY 127.0.0.1:9999',
    setProxy: async () => {}
  }))
  const usageEnvsWithoutDirect: (NodeJS.ProcessEnv | undefined)[] = []
  const runWithoutDirect: typeof runProcess = async (spec) => {
    if (spec.args?.[0] === '--version') {
      return { code: 0, signal: null, stdout: '1.5.15\n', stderr: '', timedOut: false }
    }
    usageEnvsWithoutDirect.push(spec.env)
    return {
      code: 1,
      signal: null,
      stdout: '',
      stderr: 'proxyconnect tcp: dial tcp 127.0.0.1:9999: connect: connection refused',
      timedOut: false
    }
  }

  const failedWithoutDirect = await fetchAntigravityRateLimits({
    runCommand: runWithoutDirect,
    resolveCommand: async () => '/usr/local/bin/agy',
    resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
    platform: 'darwin',
    now: () => 0
  })

  expect(failedWithoutDirect.status).toBe('error')
  expect(usageEnvsWithoutDirect.map((env) => env?.HTTPS_PROXY)).toEqual(['http://127.0.0.1:9999'])
})
