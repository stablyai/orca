import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import { resolveAgentForwardingIntent } from './ssh-agent-forwarding-intent'
import { createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'

function configTarget(overrides?: Partial<SshTarget>): SshTarget {
  return createTarget({ source: 'ssh-config', configHost: 'work', host: 'work', ...overrides })
}

describe('resolveAgentForwardingIntent', () => {
  beforeEach(() => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('follows ssh -G for config-backed targets even when an imported value disagrees', () => {
    expect(
      resolveAgentForwardingIntent(
        configTarget({ forwardAgent: false }),
        createResolvedConfig({ forwardAgent: true })
      )
    ).toEqual({ enabled: true, socket: '/tmp/agent.sock', socketSource: 'identity-agent' })
  })

  it('falls back to the imported value when ssh -G could not run', () => {
    expect(resolveAgentForwardingIntent(configTarget({ forwardAgent: true }), null)).toMatchObject({
      enabled: true
    })
    expect(resolveAgentForwardingIntent(configTarget(), null)).toEqual({
      enabled: false,
      reason: 'config-unresolved'
    })
  })

  it('lets an explicit manual choice override ~/.ssh/config either way', () => {
    const forwarding = createResolvedConfig({ forwardAgent: true })
    const notForwarding = createResolvedConfig({ forwardAgent: false })

    expect(
      resolveAgentForwardingIntent(createTarget({ forwardAgent: true }), notForwarding)
    ).toMatchObject({ enabled: true })
    expect(resolveAgentForwardingIntent(createTarget({ forwardAgent: false }), forwarding)).toEqual(
      { enabled: false, reason: 'not-requested' }
    )
    expect(resolveAgentForwardingIntent(createTarget(), forwarding)).toMatchObject({
      enabled: true
    })
  })

  it('forwards the IdentityAgent socket, matching ssh exporting it as SSH_AUTH_SOCK', () => {
    expect(
      resolveAgentForwardingIntent(
        createTarget(),
        createResolvedConfig({ forwardAgent: true, identityAgent: '/tmp/1password.sock' })
      )
    ).toMatchObject({ enabled: true, socket: '/tmp/1password.sock' })
  })

  it('reports why nothing is forwarded when no agent socket exists', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.stubEnv('SSH_AUTH_SOCK', '')

    expect(
      resolveAgentForwardingIntent(createTarget(), createResolvedConfig({ forwardAgent: true }))
    ).toEqual({ enabled: false, reason: 'no-agent-socket' })
    vi.restoreAllMocks()
  })

  it('expands a ForwardAgent $VAR against the local environment', () => {
    vi.stubEnv('WORK_AGENT_SOCK', '/tmp/work.sock')

    expect(
      resolveAgentForwardingIntent(
        createTarget(),
        createResolvedConfig({ forwardAgent: true, forwardAgentSocket: '$WORK_AGENT_SOCK' })
      )
    ).toEqual({ enabled: true, socket: '/tmp/work.sock', socketSource: 'forward-agent-path' })
  })
})
