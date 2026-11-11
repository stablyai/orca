import { describe, expect, it } from 'vitest'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'

const FAILURE = 'Could not connect to the remote Orca runtime: socket closed.'
const ENDPOINT = 'wss://203.0.113.7:6768'

describe('withRuntimeUnreachableHint', () => {
  it('hints Tailscale for a paired server on another network', () => {
    expect(
      withRuntimeUnreachableHint({ name: 'desk', source: 'manual' }, FAILURE, ENDPOINT)
    ).toMatch(/Tailscale/)
  })

  it('leaves an Orca Cloud sandbox failure without a Tailscale hint', () => {
    const cloud = {
      name: 'orca-sandbox-push-test sandbox 1a2b3c4d',
      source: 'ephemeral-vm' as const
    }
    expect(withRuntimeUnreachableHint(cloud, FAILURE, ENDPOINT)).toBe(FAILURE)
  })
})
