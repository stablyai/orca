import { expect, it } from 'vitest'
import type { runProcess } from '@orca/process-host'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'

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
