import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMetadata } from '../../shared/runtime-bootstrap'
import type { CliStatusResult } from '../../shared/runtime-types'
import {
  findServingProfileOwner,
  serveAlreadyRunningFailure,
  serveAlreadyRunningMessage
} from './serving-profile-owner'

function status(overrides: Partial<CliStatusResult['app']> & { reachable?: boolean }) {
  const { reachable = false, ...app } = overrides
  return {
    app: { running: false, pid: null, ...app },
    runtime: { state: 'not_running', reachable, runtimeId: null },
    graph: { state: 'not_running' }
  } as CliStatusResult
}

const METADATA: RuntimeMetadata = {
  runtimeId: 'runtime-1',
  pid: 77,
  transports: [{ kind: 'unix', endpoint: '/profile/o-77-a.sock' }],
  authToken: 'token',
  startedAt: 1_700_000_000_000
}

describe('findServingProfileOwner', () => {
  it('reports the owner when the runtime answers RPC without probing', async () => {
    // Why: an answered RPC proves ownership outright; a second connect would be
    // pure cost on the common path.
    const probe = vi.fn()

    await expect(
      findServingProfileOwner(
        status({ running: true, pid: 4242, reachable: true }),
        METADATA,
        probe
      )
    ).resolves.toEqual({ pid: 4242, evidence: 'rpc' })
    expect(probe).not.toHaveBeenCalled()
  })

  it('reports an owner whose socket still accepts connections', async () => {
    // Why: the runtime publishes metadata only after binding, so an accepted
    // connect proves a live owner even while it is too busy to answer RPC.
    // Spawning a second one against it is what STA-4336 crash-loops on.
    await expect(
      findServingProfileOwner(status({ running: true, pid: 77 }), METADATA, async () => 'accepting')
    ).resolves.toEqual({ pid: 77, evidence: 'listening' })
  })

  it('names the metadata pid when status could not confirm one', async () => {
    // Why: the pid is diagnostic only — a live listener is the owner regardless
    // of whether the recorded pid still resolves.
    await expect(
      findServingProfileOwner(
        status({ running: false, pid: null }),
        METADATA,
        async () => 'accepting'
      )
    ).resolves.toEqual({ pid: 77, evidence: 'listening' })
  })

  it('does not treat a crashed runtime as an owner on its pid alone', async () => {
    // Why: pids get recycled. Believing a recorded pid would make a stale
    // metadata file refuse every serve on this profile forever.
    await expect(
      findServingProfileOwner(
        status({ running: true, pid: 77 }),
        METADATA,
        async () => 'not-listening'
      )
    ).resolves.toBeNull()
  })

  it('treats an endpoint that never answered as an owner rather than free', async () => {
    // Why: a stopped runtime unlinks its socket and a crashed one leaves a path that
    // refuses — both definitive. Anything else means something still holds the endpoint,
    // and spawning into it is the pre-JS abort loop STA-4336 is about.
    await expect(
      findServingProfileOwner(status({ running: true, pid: 77 }), METADATA, async () => 'unproven')
    ).resolves.toEqual({ pid: 77, evidence: 'endpoint-held' })
  })

  it('does not treat a profile with no metadata as an owner', async () => {
    await expect(
      findServingProfileOwner(status({ running: true, pid: 77 }), null, async () => 'accepting')
    ).resolves.toBeNull()
  })
})

describe('serveAlreadyRunningMessage', () => {
  it('names the owning pid and stays actionable', () => {
    const message = serveAlreadyRunningMessage({ pid: 4242, evidence: 'rpc' })

    expect(message).toContain('pid 4242')
    expect(message).toContain('not starting a second process')
    expect(message).toContain('orca status')
  })

  it('says the owner is not answering yet when only its socket replied', () => {
    // Why: telling the user to run `orca status` as the next step would repeat
    // the call that just came back empty.
    const message = serveAlreadyRunningMessage({ pid: 9, evidence: 'listening' })

    expect(message).toContain('socket is accepting connections')
    expect(message).toContain('Wait for it to finish starting')
  })

  it('offers the stale-file escape hatch when the endpoint proved nothing', () => {
    // Why: this is the one refusal the user may have to clear by hand, so the
    // message has to name that option instead of only saying to wait.
    const message = serveAlreadyRunningMessage({ pid: 9, evidence: 'endpoint-held' })

    expect(message).toContain('neither accepted nor refused')
    expect(message).toContain('delete orca-runtime.json')
  })

  it('stays readable when the owner pid is unknown', () => {
    expect(serveAlreadyRunningMessage({ pid: null, evidence: 'rpc' })).toContain('another process')
  })
})

describe('serveAlreadyRunningFailure', () => {
  it('matches the envelope shape CLI json consumers already parse', () => {
    const owner = { pid: 4242, evidence: 'listening' } as const

    expect(serveAlreadyRunningFailure(owner)).toEqual({
      id: 'local',
      ok: false,
      error: {
        code: 'runtime_serve_already_running',
        message: serveAlreadyRunningMessage(owner),
        data: { pid: 4242, evidence: 'listening' }
      },
      _meta: { runtimeId: null }
    })
  })
})
