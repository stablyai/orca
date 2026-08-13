import { expect, it, vi } from 'vitest'
import {
  continueEphemeralVmRuntimeResume,
  createEphemeralVmRuntimeResumeCoordinator
} from './ephemeral-vm-runtime-resume-continuation'

it('coalesces concurrent resume requests per runtime', async () => {
  const coordinate = createEphemeralVmRuntimeResumeCoordinator()
  let release!: () => void
  const resume = vi.fn(
    () =>
      new Promise<null>((resolve) => {
        release = () => resolve(null)
      })
  )

  const first = coordinate('runtime-1', resume)
  const second = coordinate('runtime-1', resume)

  expect(resume).toHaveBeenCalledOnce()
  release()
  await expect(Promise.all([first, second])).resolves.toEqual([null, null])

  await coordinate('runtime-1', vi.fn().mockResolvedValue(null))
})

it('retries connection publication without rerunning the provider resume hook', async () => {
  const resumeProvider = vi.fn()
  const runtime = {
    id: 'runtime-1',
    recipeId: 'cloud-sandbox',
    status: 'resume_failed',
    cleanupStatus: 'not_started',
    resumeConnectionPending: true,
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      pairingCode: 'pairing-code',
      projectRoot: '/workspace/repo'
    }
  } as const

  await expect(continueEphemeralVmRuntimeResume(runtime, resumeProvider)).resolves.toEqual({
    ok: true,
    runtime,
    skipped: false
  })
  expect(resumeProvider).not.toHaveBeenCalled()
})
