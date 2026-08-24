import { describe, expect, it } from 'vitest'
import type { KnownRuntimeEnvironment } from '../shared/runtime-environments'
import type { SshTarget } from '../shared/ssh-types'
import { resolveRuntimeEnvironmentEditorSshTarget } from './runtime-environment-editor-ssh-target'

function environment(
  endpoint: string,
  overrides: Partial<KnownRuntimeEnvironment> = {}
): KnownRuntimeEnvironment {
  return {
    id: 'env-1',
    name: 'Build server',
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: 'runtime-1',
    endpoints: [
      {
        id: 'ws-env-1',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint,
        deviceToken: 'token',
        publicKeyB64: 'public-key'
      }
    ],
    preferredEndpointId: 'ws-env-1',
    ...overrides
  }
}

function target(overrides: Partial<SshTarget> = {}): SshTarget {
  return {
    id: 'ssh-1',
    label: 'Build server',
    configHost: 'build-box',
    host: 'runtime.example.com',
    port: 22,
    username: 'ada',
    source: 'ssh-config',
    ...overrides
  }
}

describe('resolveRuntimeEnvironmentEditorSshTarget', () => {
  it('prefers one exact config alias match over resolved-host matches', () => {
    const aliasMatch = target({ id: 'ssh-alias', configHost: 'runtime.example.com' })
    const hostMatch = target({ id: 'ssh-host', configHost: 'other-alias' })

    expect(
      resolveRuntimeEnvironmentEditorSshTarget(environment('wss://RUNTIME.EXAMPLE.COM.:6768'), [
        hostMatch,
        aliasMatch
      ])
    ).toEqual({ ok: true, target: aliasMatch })
  })

  it('does not treat a manual target configHost as an executable SSH alias', () => {
    const misleadingManualTarget = target({
      source: 'manual',
      configHost: 'runtime.example.com',
      host: 'other.example.com'
    })

    expect(
      resolveRuntimeEnvironmentEditorSshTarget(environment('ws://runtime.example.com:6768'), [
        misleadingManualTarget
      ])
    ).toEqual({ ok: false, reason: 'runtime-ssh-target-required' })
  })

  it('uses one resolved-host match when no config alias matches', () => {
    const match = target({ configHost: 'build-box', host: 'runtime.example.com' })

    expect(
      resolveRuntimeEnvironmentEditorSshTarget(environment('ws://runtime.example.com:6768'), [
        match
      ])
    ).toEqual({ ok: true, target: match })
  })

  it.each([
    ['no matching target', [target({ host: 'other.example.com' })]],
    [
      'ambiguous alias matches',
      [
        target({ id: 'ssh-1', configHost: 'runtime.example.com' }),
        target({ id: 'ssh-2', configHost: 'runtime.example.com' })
      ]
    ],
    [
      'ambiguous resolved-host matches',
      [target({ id: 'ssh-1', configHost: 'first' }), target({ id: 'ssh-2', configHost: 'second' })]
    ],
    [
      'only a hidden runtime-owned target',
      [target({ owner: { type: 'on-demand-runtime', runtimeId: 'runtime-1' } })]
    ],
    ['legacy runtime-owned target id', [target({ id: 'runtime-ssh-runtime-1' })]]
  ])('requires an explicit usable SSH target for %s', (_label, targets) => {
    expect(
      resolveRuntimeEnvironmentEditorSshTarget(
        environment('ws://runtime.example.com:6768'),
        targets
      )
    ).toEqual({ ok: false, reason: 'runtime-ssh-target-required' })
  })

  it.each([
    ['loopback endpoint', environment('ws://127.0.0.1:6768')],
    [
      'SSH-tunnel dependency',
      environment('ws://runtime.example.com:6768', { connectionDependency: 'ssh-tunnel' })
    ],
    ['ephemeral VM', environment('ws://runtime.example.com:6768', { source: 'ephemeral-vm' })],
    ['non-WebSocket endpoint', environment('https://runtime.example.com')],
    ['malformed endpoint', environment('not a URL')],
    ['wildcard endpoint', environment('ws://0.0.0.0:6768')],
    ['zero port endpoint', environment('ws://runtime.example.com:0')],
    ['reverse-proxy endpoint', environment('ws://runtime.example.com/orca')]
  ])('rejects the unsupported Runtime topology: %s', (_label, runtimeEnvironment) => {
    expect(resolveRuntimeEnvironmentEditorSshTarget(runtimeEnvironment, [target()])).toEqual({
      ok: false,
      reason: 'remote-runtime-unsupported'
    })
  })

  it('uses the preferred direct endpoint when a Runtime has multiple endpoints', () => {
    const selected = target({ host: 'selected.example.com' })
    const runtime = environment('ws://first.example.com:6768', {
      endpoints: [
        {
          id: 'ws-first',
          kind: 'websocket',
          label: 'First',
          endpoint: 'ws://first.example.com:6768',
          deviceToken: 'token-1',
          publicKeyB64: 'public-key-1'
        },
        {
          id: 'ws-selected',
          kind: 'websocket',
          label: 'Selected',
          endpoint: 'wss://selected.example.com:6768',
          deviceToken: 'token-2',
          publicKeyB64: 'public-key-2'
        }
      ],
      preferredEndpointId: 'ws-selected'
    })

    expect(resolveRuntimeEnvironmentEditorSshTarget(runtime, [selected])).toEqual({
      ok: true,
      target: selected
    })
  })

  it('rejects a stale preferred endpoint instead of using another endpoint', () => {
    expect(
      resolveRuntimeEnvironmentEditorSshTarget(
        environment('ws://runtime.example.com:6768', { preferredEndpointId: 'missing-endpoint' }),
        [target()]
      )
    ).toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
  })

  it('fails closed for an IPv6 wildcard endpoint', () => {
    expect(
      resolveRuntimeEnvironmentEditorSshTarget(environment('ws://[::]:6768'), [
        target({ host: '::' })
      ])
    ).toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
  })
})
