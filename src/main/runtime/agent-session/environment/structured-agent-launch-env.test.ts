import { describe, expect, it } from 'vitest'
import { structuredAgentLaunchEnv } from './structured-agent-launch-env'

const proxy = {
  httpProxyUrl: 'http://proxy.test:8080',
  httpProxyBypassRules: 'localhost;10.0.0.0/8'
}

describe('structuredAgentLaunchEnv', () => {
  it('gives chat agents the configured proxy', () => {
    expect(structuredAgentLaunchEnv('claude', proxy, {}, 'darwin')).toEqual({
      HTTP_PROXY: 'http://proxy.test:8080',
      HTTPS_PROXY: 'http://proxy.test:8080',
      ALL_PROXY: 'http://proxy.test:8080',
      http_proxy: 'http://proxy.test:8080',
      https_proxy: 'http://proxy.test:8080',
      all_proxy: 'http://proxy.test:8080',
      NO_PROXY: 'localhost,10.0.0.0/8',
      no_proxy: 'localhost,10.0.0.0/8'
    })
  })

  it('adds nothing when no proxy is configured', () => {
    expect(structuredAgentLaunchEnv('claude', { httpProxyUrl: '' }, {}, 'darwin')).toEqual({})
  })

  it("lets the agent's own proxy replace every spelling of the configured one", () => {
    const env = structuredAgentLaunchEnv(
      'codex',
      { ...proxy, agentDefaultEnv: { codex: { HTTPS_PROXY: 'http://mine:1' } } },
      {},
      'darwin'
    )
    expect(Object.entries(env).filter(([key]) => key.toUpperCase() === 'HTTPS_PROXY')).toEqual([
      ['HTTPS_PROXY', 'http://mine:1']
    ])
    expect(env.http_proxy).toBe('http://proxy.test:8080')
  })
})
