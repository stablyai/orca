import { afterEach, expect, it, vi } from 'vitest'
import { RelayRuntimeServices } from './relay-runtime-services'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const skill = vi.fn(async () => {})
  const vault = vi.fn(async () => {})
  const agents = vi.fn(async () => {})
  const responses = vi.fn(async () => {})
  const fileStreams = vi.fn(async () => {})
  const watchers = vi.fn(async () => {})
  const runtime = Object.assign(Object.create(RelayRuntimeServices.prototype), {
    skillInstallHandler: { dispose: skill },
    aiVaultService: { dispose: vault },
    agentExecHandler: { dispose: agents },
    responseStreams: { disposeAllAndWait: responses },
    fsHandler: { disposeFileStreams: fileStreams, disposeWatchers: watchers }
  }) as RelayRuntimeServices
  return { runtime, skill, vault, agents, responses, fileStreams, watchers }
}

it('waits for every owned cleanup before acknowledging shutdown', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  f.vault.mockReturnValue(pending.promise)
  const finished = vi.fn()
  const shutdown = f.runtime.disposeOwnedProcesses().then(finished)
  await vi.waitFor(() => expect(f.vault).toHaveBeenCalledOnce())
  expect(finished).not.toHaveBeenCalled()
  pending.resolve()
  await shutdown
  expect(f.skill).toHaveBeenCalledOnce()
  expect(finished).toHaveBeenCalledOnce()
})

it.each(['skill', 'vault', 'both'] as const)(
  'rejects %s cleanup failure after attempting both owners and supports retry',
  async (stage) => {
    const f = fixture()
    const errors: Error[] = []
    for (const [name, dispose] of [
      ['skill', f.skill],
      ['vault', f.vault]
    ] as const) {
      if (stage === name || stage === 'both') {
        const error = new Error(`${name} cleanup failed`)
        errors.push(error)
        dispose.mockRejectedValueOnce(error)
      }
    }
    await expect(f.runtime.disposeOwnedProcesses()).rejects.toMatchObject({
      message: 'relay_owned_process_shutdown_incomplete',
      errors
    })
    expect(f.skill).toHaveBeenCalledOnce()
    expect(f.vault).toHaveBeenCalledOnce()
    await expect(f.runtime.disposeOwnedProcesses()).resolves.toBeUndefined()
  }
)

it('handles hosts without a vault service', async () => {
  const f = fixture()
  Object.assign(f.runtime, { aiVaultService: null })
  await expect(f.runtime.disposeOwnedProcesses()).resolves.toBeUndefined()
  expect(f.skill).toHaveBeenCalledOnce()
  expect(f.vault).not.toHaveBeenCalled()
})

it('starts agent shutdown before other cleanup and waits for its physical-close barrier', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<void>()
  f.agents.mockReturnValue(pending.promise)
  const finished = vi.fn()
  const shutdown = f.runtime.disposeOwnedProcesses().then(finished)
  expect(f.agents).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(f.vault).toHaveBeenCalledOnce())
  expect(finished).not.toHaveBeenCalled()
  pending.resolve()
  await shutdown
})

it('does not acknowledge failed agent shutdown after cleaning other owners', async () => {
  const f = fixture()
  const error = new Error('agent cleanup failed')
  f.agents.mockRejectedValueOnce(error)
  await expect(f.runtime.disposeOwnedProcesses()).rejects.toMatchObject({ errors: [error] })
  expect(f.skill).toHaveBeenCalledOnce()
  expect(f.vault).toHaveBeenCalledOnce()
})

it.each(['responses', 'fileStreams', 'watchers'] as const)(
  'does not acknowledge cleanup before %s have settled',
  async (owner) => {
    const f = fixture()
    const pending = Promise.withResolvers<void>()
    f[owner].mockReturnValue(pending.promise)
    const finished = vi.fn()
    const shutdown = f.runtime.disposeOwnedProcesses().then(finished)
    expect(f[owner]).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(f.vault).toHaveBeenCalledOnce())
    expect(finished).not.toHaveBeenCalled()
    pending.resolve()
    await shutdown
  }
)
