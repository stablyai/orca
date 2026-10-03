import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  createEnvironmentFromPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { emptyOrcadActivationRecord } from './orcad-activation-record'

const mocks = vi.hoisted(() => ({ send: vi.fn(), ensure: vi.fn() }))
vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequestWithStatusPreflight: mocks.send
}))
vi.mock('./orcad-managed-tunnel', () => ({ ensureOrcadManagedTunnel: mocks.ensure }))

const { collectManagedTerminalCensus, collectRemoteOrcadTerminalCensus } =
  await import('./orcad-terminal-census-client')

const environment: KnownRuntimeEnvironment = createEnvironmentFromPairingOffer({
  id: 'environment-1',
  name: 'Managed',
  now: 1,
  offer: { v: 2, endpoint: 'ws://127.0.0.1:46768', deviceToken: 't', publicKeyB64: 'k' },
  connectionDependency: 'ssh-tunnel'
})
const active = {
  ...emptyOrcadActivationRecord(),
  active: '1.0.0',
  activatedAt: '2026-01-01T00:00:00.000Z'
}
const unverifiable = {
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
}
const census = { liveSessions: 2, startedSinceActivation: 1, daemonProtocolVersion: 7 }

function answerWith(capabilities: string[], response: unknown) {
  mocks.send.mockImplementation(async (_pairing, _method, _params, _timeout, validate) => {
    validate({ ok: true, result: { capabilities } })
    return response
  })
}

describe('managed orcad terminal census client', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.ensure.mockResolvedValue(undefined)
  })

  it('reads an idle census without contacting a host that has nothing active', async () => {
    await expect(
      collectRemoteOrcadTerminalCensus(environment, { ...active, active: null })
    ).resolves.toEqual({ liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null })
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('asks an advertising host with the activation time', async () => {
    answerWith([ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY], { ok: true, result: census })
    await expect(collectRemoteOrcadTerminalCensus(environment, active)).resolves.toEqual(census)
    expect(mocks.send.mock.calls[0]?.slice(1, 3)).toEqual([
      'orcad.terminalCensus',
      { activatedAt: Date.parse(active.activatedAt) }
    ])
  })

  it.each([
    ['an older host without the capability', () => answerWith([], { ok: true, result: census })],
    [
      'method not found',
      () =>
        answerWith([ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY], {
          ok: false,
          error: { code: 'method_not_found', message: 'no' }
        })
    ],
    [
      'a malformed answer',
      () => answerWith([ORCAD_TERMINAL_CENSUS_RUNTIME_CAPABILITY], { ok: true, result: {} })
    ],
    ['loss of contact', () => mocks.send.mockRejectedValue(new Error('socket closed'))]
  ])('reads %s as unverifiable, never as zero', async (_label, arrange) => {
    arrange()
    await expect(collectRemoteOrcadTerminalCensus(environment, active)).resolves.toEqual(
      unverifiable
    )
  })

  it('reads an unparseable activation time as unverifiable', async () => {
    await expect(
      collectRemoteOrcadTerminalCensus(environment, { ...active, activatedAt: 'later' })
    ).resolves.toEqual(unverifiable)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('reads a tunnel that cannot open as unverifiable', async () => {
    mocks.ensure.mockRejectedValue(new Error('SSH unavailable'))
    await expect(collectManagedTerminalCensus('/profile', environment, active)).resolves.toEqual(
      unverifiable
    )
  })
})
