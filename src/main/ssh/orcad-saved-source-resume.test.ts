import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { connectOrcadSavedSshSource } from './orcad-saved-source-connection'
import { resumeSshPtyConsumerSession } from './ssh-pty-consumer-session'
import { resumeOrcadSavedSshSource } from './orcad-saved-source-resume'

vi.mock('./orcad-saved-source-connection', () => ({ connectOrcadSavedSshSource: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({ resumeSshPtyConsumerSession: vi.fn() }))

function fixture() {
  const recovery = {
    targetId: 'source',
    clientInstanceId: 'client',
    serverBuildId: 'build',
    clientGeneration: 2,
    ownerGeneration: 2,
    ownerLease: 'saved-lease',
    outputFlowControl: { version: 1 as const, windowSu: 512 }
  }
  let saved: typeof recovery | null = structuredClone(recovery)
  const store = {
    getSshPtyConsumerRecovery: vi.fn(() => saved && structuredClone(saved)),
    upsertSshPtyConsumerRecovery: vi.fn(async (record) => {
      saved = structuredClone(record)
    })
  }
  const connection = { dispose: vi.fn(), disconnect: vi.fn() }
  const transport = {
    mux: {},
    connection,
    transportGeneration: 3,
    assertCurrent: vi.fn(),
    dispose: vi.fn()
  }
  const admission = {
    resumed: true,
    state: {
      mode: 'negotiated' as const,
      clientInstanceId: 'client',
      clientGeneration: 3,
      ownerGeneration: 3,
      ownerLease: 'saved-lease',
      outputFlowControl: { version: 1 as const, windowSu: 256 }
    }
  }
  vi.mocked(connectOrcadSavedSshSource).mockImplementation(async (args) => {
    transport.assertCurrent.mockImplementation(args.assertAuthority)
    return transport as never
  })
  vi.mocked(resumeSshPtyConsumerSession).mockResolvedValue(admission)
  const options = {
    connection: connection as never,
    store,
    targetId: 'source',
    ownerLease: 'saved-lease',
    source: {
      endpoint: '/saved.sock',
      incumbentVersion: 'build',
      endpointCredential: 'a'.repeat(43)
    },
    signal: new AbortController().signal,
    assertAuthority: vi.fn()
  }
  return {
    options,
    store,
    connection,
    transport,
    admission,
    recovery,
    replace: (record: typeof recovery | null) => {
      saved = record
    }
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('ORCA_ENABLE_PTY_OWNERSHIP_TRANSFER_MUTATION', '1')
})
afterEach(() => vi.unstubAllEnvs())

it('refuses default-disabled mutation before opening a connection', async () => {
  const f = fixture()
  vi.stubEnv('ORCA_ENABLE_PTY_OWNERSHIP_TRANSFER_MUTATION', undefined)
  await expect(resumeOrcadSavedSshSource(f.options)).rejects.toThrow('mutation_disabled')
  expect(connectOrcadSavedSshSource).not.toHaveBeenCalled()
})

it('persists the resumed owner before returning retirement authority', async () => {
  const f = fixture()
  const result = await resumeOrcadSavedSshSource(f.options)
  const { mode: _mode, ...claim } = f.admission.state
  expect(f.store.getSshPtyConsumerRecovery()).toEqual({
    ...claim,
    targetId: 'source',
    serverBuildId: 'build'
  })
  expect(resumeSshPtyConsumerSession).toHaveBeenCalledWith(
    f.transport.mux,
    expect.objectContaining({
      clientInstanceId: 'client',
      expectedServerBuildId: 'build',
      resume: { ownerGeneration: 2, ownerLease: 'saved-lease' },
      outputFlowControl: { requestedWindowSu: 512 }
    })
  )
  expect(result.session.owner).toEqual(f.admission.state)
  expect(result.session.resumed).toBe(true)
  expect(Object.isFrozen(result.session.owner)).toBe(true)
  result.assertCurrent()
  expect(f.transport.dispose).not.toHaveBeenCalled()
})

it.each(['missing', 'lease', 'build', 'target'])(
  'refuses %s saved recovery before opening any transport',
  async (kind) => {
    const f = fixture()
    if (kind === 'missing') {
      f.replace(null)
    }
    if (kind === 'lease') {
      f.replace({ ...f.recovery, ownerLease: 'other' })
    }
    if (kind === 'build') {
      f.replace({ ...f.recovery, serverBuildId: 'other' })
    }
    if (kind === 'target') {
      f.replace({ ...f.recovery, targetId: 'other' })
    }
    await expect(resumeOrcadSavedSshSource(f.options)).rejects.toThrow('owner_required')
    expect(connectOrcadSavedSshSource).not.toHaveBeenCalled()
    expect(resumeSshPtyConsumerSession).not.toHaveBeenCalled()
  }
)

it.each(['refused', 'not-resumed', 'legacy'])(
  'disposes only the owned transport for a %s admission',
  async (kind) => {
    const f = fixture()
    if (kind === 'refused') {
      vi.mocked(resumeSshPtyConsumerSession).mockRejectedValue(new Error('refused'))
    }
    if (kind === 'not-resumed') {
      f.admission.resumed = false
    }
    if (kind === 'legacy') {
      vi.mocked(resumeSshPtyConsumerSession).mockResolvedValue({
        resumed: true,
        state: { mode: 'legacy-fallback', clientInstanceId: 'client', serverBuildId: 'build' }
      })
    }
    await expect(resumeOrcadSavedSshSource(f.options)).rejects.toThrow()
    expect(f.transport.dispose).toHaveBeenCalledOnce()
    expect(f.store.upsertSshPtyConsumerRecovery).not.toHaveBeenCalled()
    expect(f.connection.dispose).not.toHaveBeenCalled()
    expect(f.connection.disconnect).not.toHaveBeenCalled()
  }
)

it('does not overwrite recovery changed while the resume RPC is pending', async () => {
  const f = fixture()
  vi.mocked(resumeSshPtyConsumerSession).mockImplementation(async () => {
    f.replace({ ...f.recovery, ownerGeneration: 9 })
    return f.admission
  })
  await expect(resumeOrcadSavedSshSource(f.options)).rejects.toThrow('owner_changed')
  expect(f.store.upsertSshPtyConsumerRecovery).not.toHaveBeenCalled()
  expect(f.transport.dispose).toHaveBeenCalledOnce()
})

it('does not return a usable session when durable persistence fails', async () => {
  const f = fixture()
  f.store.upsertSshPtyConsumerRecovery.mockRejectedValue(new Error('disk-failed'))
  await expect(resumeOrcadSavedSshSource(f.options)).rejects.toThrow('disk-failed')
  expect(f.transport.dispose).toHaveBeenCalledOnce()
  expect(f.store.getSshPtyConsumerRecovery()).toEqual(f.recovery)
})

it('waits for durable flush even when the new recovery is already visible in memory', async () => {
  const f = fixture()
  const saving = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  f.store.upsertSshPtyConsumerRecovery.mockImplementation(async (record) => {
    f.replace(record)
    started.resolve()
    await saving.promise
  })
  const returned = vi.fn()
  const pending = resumeOrcadSavedSshSource(f.options).then(returned)
  await started.promise
  expect(f.store.getSshPtyConsumerRecovery()?.ownerGeneration).toBe(3)
  expect(returned).not.toHaveBeenCalled()
  saving.resolve()
  await pending
  expect(returned).toHaveBeenCalledOnce()
})

it('requires the persisted record to match the granted owner', async () => {
  const f = fixture()
  f.store.upsertSshPtyConsumerRecovery.mockResolvedValue(undefined)
  await expect(resumeOrcadSavedSshSource(f.options)).rejects.toThrow('owner_changed')
  expect(f.transport.dispose).toHaveBeenCalledOnce()
})

it('rechecks the exact persisted owner after return', async () => {
  const f = fixture()
  const result = await resumeOrcadSavedSshSource(f.options)
  f.replace({ ...f.recovery, ownerGeneration: 8 })
  expect(() => result.assertCurrent()).toThrow('owner_changed')
})
