import { afterEach, expect, it, vi } from 'vitest'
import { RelayRuntimeServices } from './relay-runtime-services'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const skill = vi.fn(async () => {})
  const vault = vi.fn(async () => {})
  const responses = vi.fn(async () => {})
  const fileStreams = vi.fn(async () => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: disposeOwnedProcesses only reads the owners stubbed here.
  const runtime = Object.assign(Object.create(RelayRuntimeServices.prototype), {
    skillInstallHandler: { dispose: skill },
    aiVaultService: { dispose: vault },
    responseStreams: { disposeAllAndWait: responses },
    fsHandler: { disposeFileStreams: fileStreams }
  }) as RelayRuntimeServices
  return { runtime, skill, vault, responses, fileStreams }
}

it.each(['responses', 'fileStreams'] as const)(
  'does not acknowledge cleanup before %s have settled',
  async (owner) => {
    const f = fixture()
    let release!: () => void
    f[owner].mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const finished = vi.fn()
    const shutdown = f.runtime.disposeOwnedProcesses().then(finished)
    expect(f[owner]).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(f.vault).toHaveBeenCalledOnce())
    expect(finished).not.toHaveBeenCalled()
    release()
    await shutdown
    expect(finished).toHaveBeenCalledOnce()
  }
)

it('rejects stream drain failures after attempting every owner and supports retry', async () => {
  const f = fixture()
  const responseError = new Error('response drain failed')
  const fileError = new Error('file drain failed')
  f.responses.mockRejectedValueOnce(responseError)
  f.fileStreams.mockRejectedValueOnce(fileError)
  await expect(f.runtime.disposeOwnedProcesses()).rejects.toMatchObject({
    message: 'relay_owned_process_shutdown_incomplete',
    errors: [responseError, fileError]
  })
  expect(f.skill).toHaveBeenCalledOnce()
  expect(f.vault).toHaveBeenCalledOnce()
  await expect(f.runtime.disposeOwnedProcesses()).resolves.toBeUndefined()
})

it('keeps skill and AI Vault cleanup failures log-and-continue', async () => {
  const f = fixture()
  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  f.skill.mockRejectedValueOnce(new Error('skill cleanup failed'))
  f.vault.mockRejectedValueOnce(new Error('vault cleanup failed'))
  await expect(f.runtime.disposeOwnedProcesses()).resolves.toBeUndefined()
  expect(f.responses).toHaveBeenCalledOnce()
  expect(f.fileStreams).toHaveBeenCalledOnce()
})

it('handles hosts without a vault service', async () => {
  const f = fixture()
  Object.assign(f.runtime, { aiVaultService: null })
  await expect(f.runtime.disposeOwnedProcesses()).resolves.toBeUndefined()
  expect(f.vault).not.toHaveBeenCalled()
})
