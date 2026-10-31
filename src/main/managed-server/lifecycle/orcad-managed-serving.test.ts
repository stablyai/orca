import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../install/orcad-remote-context', () => ({
  resolveOrcadRemoteContext: vi.fn(async () => ({
    connection: {},
    host: {},
    remoteHome: '/home/u',
    userDataDir: '/home/u/.orca'
  }))
}))
vi.mock('./orcad-managed-wake', () => ({ wakeStoppedManagedOrcad: vi.fn() }))

import { wakeStoppedManagedOrcad } from './orcad-managed-wake'
import {
  ensureManagedOrcadServing,
  resetManagedOrcadServingForTests,
  type OrcadManagedServingInput
} from './orcad-managed-serving'
import {
  MANAGED_ORCAD_NOT_ACTIVATED_DETAIL,
  setManagedOrcadStartListener
} from './orcad-managed-serving-state'

const listener = { starting: vi.fn(), settled: vi.fn() }
let generation = 1
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the transport generation is read; the remote context is mocked.
const connection = { getConnectGeneration: () => generation } as never

function input(probe: () => Promise<boolean>): OrcadManagedServingInput {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the id is read.
    environment: { id: 'env-1' } as never,
    target: { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' },
    connection,
    remotePort: 6768,
    probe: vi.fn(probe)
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetManagedOrcadServingForTests()
  setManagedOrcadStartListener(listener)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('ensureManagedOrcadServing', () => {
  it('keeps a listener registered before the serving implementation loads', async () => {
    vi.resetModules()
    const state = await import('./orcad-managed-serving-state')
    const earlyListener = { starting: vi.fn(), settled: vi.fn() }
    state.setManagedOrcadStartListener(earlyListener)
    const { ensureManagedOrcadServing: ensureServing } = await import('./orcad-managed-serving')
    vi.mocked(wakeStoppedManagedOrcad).mockImplementation(async (_slot, onStarting) => {
      onStarting?.()
      throw new Error('The server did not become ready')
    })

    expect(await ensureServing(input(async () => false))).toEqual({
      state: 'unverifiable',
      detail: 'The server did not become ready'
    })
    expect(earlyListener.starting).toHaveBeenCalledOnce()
    expect(earlyListener.settled).toHaveBeenCalledWith(expect.anything(), 'env-1', {
      state: 'unverifiable',
      detail: 'The server did not become ready'
    })
    state.setManagedOrcadStartListener(null)
  })

  it('costs one round trip when the server answers', async () => {
    expect(await ensureManagedOrcadServing(input(async () => true))).toEqual({ state: 'serving' })
    expect(wakeStoppedManagedOrcad).not.toHaveBeenCalled()
    expect(listener.starting).not.toHaveBeenCalled()
  })

  it('starts a stopped server from its slot and shows the start on the status line', async () => {
    vi.mocked(wakeStoppedManagedOrcad).mockImplementation(async (_slot, onStarting) => {
      onStarting?.()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only health is read.
      return { outcome: 'started', readiness: { health: { previousIdleStop: null } } as never }
    })

    expect(await ensureManagedOrcadServing(input(async () => false))).toEqual({
      state: 'started',
      boundPort: null
    })
    expect(vi.mocked(wakeStoppedManagedOrcad).mock.calls[0]?.[0]).toMatchObject({ port: 6768 })
    expect(listener.starting).toHaveBeenCalledOnce()
    expect(listener.settled).toHaveBeenCalledWith(expect.anything(), 'env-1', {
      state: 'started',
      boundPort: null
    })
  })

  it('uses a replacement listener when a pending wake settles', async () => {
    const started = Promise.withResolvers<void>()
    const finishWake = Promise.withResolvers<void>()
    vi.mocked(wakeStoppedManagedOrcad).mockImplementation(async (_slot, onStarting) => {
      onStarting?.()
      started.resolve()
      await finishWake.promise
      throw new Error('The server did not become ready')
    })
    const replacement = { starting: vi.fn(), settled: vi.fn() }
    const operation = ensureManagedOrcadServing(input(async () => false))
    await started.promise
    setManagedOrcadStartListener(replacement)
    finishWake.resolve()

    expect(await operation).toEqual({
      state: 'unverifiable',
      detail: 'The server did not become ready'
    })
    expect(listener.starting).toHaveBeenCalledOnce()
    expect(listener.settled).not.toHaveBeenCalled()
    expect(replacement.starting).not.toHaveBeenCalled()
    expect(replacement.settled).toHaveBeenCalledWith(expect.anything(), 'env-1', {
      state: 'unverifiable',
      detail: 'The server did not become ready'
    })
  })

  it('stays unverifiable with the reason when the start fails, never a terminal verdict', async () => {
    vi.mocked(wakeStoppedManagedOrcad).mockImplementation(async (_slot, onStarting) => {
      onStarting?.()
      throw new Error('orcad did not become ready.\nLast lines of orcad.log:\nboom')
    })

    const serving = await ensureManagedOrcadServing(input(async () => false))
    expect(serving).toEqual({
      state: 'unverifiable',
      detail: 'orcad did not become ready.\nLast lines of orcad.log:\nboom'
    })
    expect(listener.settled).toHaveBeenCalledWith(expect.anything(), 'env-1', serving)
  })

  it('leaves a live process that did not answer alone', async () => {
    vi.mocked(wakeStoppedManagedOrcad).mockResolvedValue({ outcome: 'serving' })
    const serving = await ensureManagedOrcadServing(input(async () => false))
    expect(serving).toMatchObject({ state: 'unverifiable' })
    expect(listener.starting).not.toHaveBeenCalled()
  })

  it('accepts a live process once a fresh probe answers after the host check', async () => {
    vi.mocked(wakeStoppedManagedOrcad).mockResolvedValue({ outcome: 'serving' })
    const probe = vi.fn(async () => true).mockResolvedValueOnce(false)
    expect(await ensureManagedOrcadServing(input(probe))).toEqual({ state: 'serving' })
    expect(probe).toHaveBeenCalledTimes(2)
    expect(listener.starting).not.toHaveBeenCalled()
  })

  it('keeps a failed fresh probe unverifiable without starting another process', async () => {
    vi.mocked(wakeStoppedManagedOrcad).mockResolvedValue({ outcome: 'serving' })
    const probe = vi
      .fn(async () => false)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('SSH link was replaced'))
    expect(await ensureManagedOrcadServing(input(probe))).toEqual({
      state: 'unverifiable',
      detail: 'SSH link was replaced'
    })
    expect(listener.starting).not.toHaveBeenCalled()
  })

  it.each(['fenced', 'unverifiable', 'not-activated'] as const)(
    'does not start a server whose host says %s',
    async (outcome) => {
      vi.mocked(wakeStoppedManagedOrcad).mockResolvedValue({ outcome })
      const serving = await ensureManagedOrcadServing(input(async () => false))
      expect(serving.state).toBe('unverifiable')
      expect(listener.starting).not.toHaveBeenCalled()
    }
  )

  it('shares one check between a fresh tunnel and the connect right after it', async () => {
    let now = 0
    const probe = vi.fn(async () => true)
    const first = input(probe)
    await Promise.all([
      ensureManagedOrcadServing(first, () => now),
      ensureManagedOrcadServing(first, () => now)
    ])
    now = 4_000
    await ensureManagedOrcadServing(first, () => now)
    expect(probe).toHaveBeenCalledOnce()
    now = 6_000
    await ensureManagedOrcadServing(first, () => now)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('runs its own start on a reconnected transport instead of inheriting a dropped one', async () => {
    let dropFirst!: (error: Error) => void
    vi.mocked(wakeStoppedManagedOrcad)
      .mockImplementationOnce(
        (_slot, onStarting) =>
          new Promise((_resolve, reject) => {
            onStarting?.()
            dropFirst = reject
          })
      )
      .mockImplementationOnce(async () => ({
        outcome: 'started',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only health and boundEndpoint are read.
        readiness: { health: { previousIdleStop: null } } as never
      }))
    const onDropped = ensureManagedOrcadServing(input(async () => false))
    await vi.waitFor(() => expect(wakeStoppedManagedOrcad).toHaveBeenCalledOnce())

    generation += 1
    const onReconnected = ensureManagedOrcadServing(input(async () => false))
    dropFirst(new Error('SSH connection lost'))

    expect(await onReconnected).toEqual({ state: 'started', boundPort: null })
    expect(await onDropped).toMatchObject({ state: 'unverifiable' })
    expect(wakeStoppedManagedOrcad).toHaveBeenCalledTimes(2)
  })

  it('never answers a new SSH transport from an earlier verdict, as after a reboot', async () => {
    const probe = vi.fn(async () => true)
    await ensureManagedOrcadServing(input(probe), () => 0)
    generation += 1
    await ensureManagedOrcadServing(input(probe), () => 1)
    expect(probe).toHaveBeenCalledTimes(2)
    await ensureManagedOrcadServing({ ...input(probe), remotePort: 40_001 }, () => 2)
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('skips the probe after an idle pause while the control socket keeps answering', async () => {
    let now = 0
    const probe = vi.fn(async () => true)
    const answeredAt = vi.fn((): number | null => null)
    const live = { ...input(probe), answeredAt }
    await ensureManagedOrcadServing(live, () => now)
    expect(probe).toHaveBeenCalledOnce()

    now = 6_000
    answeredAt.mockReturnValue(4_000)
    expect(await ensureManagedOrcadServing(live, () => now)).toEqual({ state: 'serving' })
    expect(answeredAt).toHaveBeenCalledWith('env-1')
    expect(probe).toHaveBeenCalledOnce()
  })

  it('shares one probe between concurrent calls once the last answer is stale', async () => {
    let answer!: (value: boolean) => void
    const probe = vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve)))
    const stale = { ...input(probe), answeredAt: () => 0 }
    const calls = [1, 2, 3].map(() => ensureManagedOrcadServing(stale, () => 60_000))
    answer(true)
    expect(await Promise.all(calls)).toEqual([
      { state: 'serving' },
      { state: 'serving' },
      { state: 'serving' }
    ])
    expect(probe).toHaveBeenCalledOnce()
  })

  it('still detects a stopped server once its control socket closed', async () => {
    vi.mocked(wakeStoppedManagedOrcad).mockResolvedValue({ outcome: 'not-activated' })
    const answeredAt = vi.fn((): number | null => 0)
    const probe = vi.fn(async () => true)
    const watched = { ...input(probe), answeredAt }
    expect(await ensureManagedOrcadServing(watched, () => 0)).toEqual({ state: 'serving' })
    expect(probe).not.toHaveBeenCalled()

    answeredAt.mockReturnValue(null)
    probe.mockResolvedValue(false)
    expect(await ensureManagedOrcadServing(watched, () => 1_000)).toEqual({
      state: 'unverifiable',
      detail: MANAGED_ORCAD_NOT_ACTIVATED_DETAIL
    })
    expect(probe).toHaveBeenCalledOnce()
  })

  it('does not take an answer from a wall clock that moved backwards as proof', async () => {
    const probe = vi.fn(async () => true)
    await ensureManagedOrcadServing({ ...input(probe), answeredAt: () => 50_000 }, () => 10_000)
    expect(probe).toHaveBeenCalledOnce()
  })
})
