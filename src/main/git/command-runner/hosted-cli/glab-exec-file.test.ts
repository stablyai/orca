import { afterEach, describe, expect, it, vi } from 'vitest'

const { captureMock } = vi.hoisted(() => ({
  captureMock: vi.fn(
    async (
      _binary: string,
      _args: string[],
      _options: { env?: NodeJS.ProcessEnv; stdin?: string }
    ) => ({
      stdout: '[]',
      stderr: ''
    })
  )
}))
vi.mock('../process-capture/exec-file-capture', () => ({
  execFileCaptureToTermination: captureMock
}))

import { glabExecFileAsync } from './glab-exec-file'
import { setNetworkProxySettingsSource } from '../../../browser/network/execution-routes/browser-network-proxy-settings-source'
import { PROXY_ENV_KEYS } from '../../../../shared/network/network-proxy'

describe('glabExecFileAsync proxy env', () => {
  afterEach(() => {
    setNetworkProxySettingsSource(null)
    vi.unstubAllEnvs()
    captureMock.mockClear()
  })

  it('applies the Settings proxy when no proxy is inherited', async () => {
    setNetworkProxySettingsSource(() => ({
      httpProxyUrl: 'http://proxy.example:3128',
      httpProxyBypassRules: 'localhost;10.0.0.0/8'
    }))
    for (const key of PROXY_ENV_KEYS) {
      vi.stubEnv(key, '')
    }

    await glabExecFileAsync(['mr', 'list', '--hostname', 'gitlab.example:8443'])

    const env = captureMock.mock.calls[0]?.[2]?.env
    expect(env).toMatchObject({
      GITLAB_HOST: 'gitlab.example:8443',
      HTTPS_PROXY: 'http://proxy.example:3128',
      https_proxy: 'http://proxy.example:3128'
    })
  })

  it('sends stdin to glab, so a request body never goes in the arguments', async () => {
    await glabExecFileAsync(['api', '-X', 'POST', 'projects/1/hooks', '--input', '-'], {
      stdin: '{"signing_token":"whsec_x"}'
    })

    expect(captureMock.mock.calls[0]?.[2]?.stdin).toBe('{"signing_token":"whsec_x"}')
  })
})
