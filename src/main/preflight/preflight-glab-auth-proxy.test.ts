import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('../ipc/preflight/preflight-command-exec', () => ({
  execCommandInWslOrThrow: vi.fn(),
  execLocalPreflightCommandOrThrow: mocks.exec,
  findRunnableLocalCommand: async (command: string) => ({
    status: 'available',
    binary: `/bin/${command}`
  }),
  isCommandAvailable: vi.fn()
}))
vi.mock('../ipc/command-path/agent-detection-shell-path', () => ({
  hydrateShellPathForAgentDetection: async () => {}
}))
vi.mock('../bitbucket/client', () => ({ getBitbucketAuthStatus: async () => undefined }))
vi.mock('../azure-devops/client', () => ({ getAzureDevOpsAuthStatus: async () => undefined }))
vi.mock('../gitea/client', () => ({ getGiteaAuthStatus: async () => undefined }))

import { setNetworkProxySettingsSource } from '../browser/network/execution-routes/browser-network-proxy-settings-source'
import { _resetPreflightCache, runPreflightCheck } from './agent-detection'
import { PROXY_ENV_KEYS } from '../../shared/network/network-proxy'

afterEach(() => {
  setNetworkProxySettingsSource(null)
  _resetPreflightCache()
  mocks.exec.mockReset()
  vi.unstubAllEnvs()
})

it('runs the glab auth probe through the Settings proxy', async () => {
  setNetworkProxySettingsSource(() => ({
    httpProxyUrl: 'http://proxy.example:3128',
    httpProxyBypassRules: ''
  }))
  for (const key of PROXY_ENV_KEYS) {
    vi.stubEnv(key, '')
  }
  mocks.exec.mockResolvedValue({ stdout: '', stderr: '' })

  const status = await runPreflightCheck(true)

  const glabCall = mocks.exec.mock.calls.find(([binary]) => binary === '/bin/glab')
  expect(glabCall?.[2]?.env).toMatchObject({ HTTPS_PROXY: 'http://proxy.example:3128' })
  expect(status.glab).toEqual({ installed: true, authenticated: true })
})
