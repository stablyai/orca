import { describe, expect, it, vi } from 'vitest'
import { SshPtyModelAdmission } from './ssh-pty-model-admission'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function accept(admission: SshPtyModelAdmission, completion: Promise<void>) {
  return admission.accept({ ptyId: 'pty-1', providerGeneration: 7 }, 'data', 4, () => ({
    sequence: 4,
    completion
  }))
}

describe('SshPtyModelAdmission', () => {
  it('freezes migration while retaining the running raw completion', async () => {
    const runningCompletion = deferred()
    const admission = new SshPtyModelAdmission()
    const running = accept(admission, runningCompletion.promise)
    const queued = accept(admission, Promise.resolve())

    admission.beginMigration({ ptyId: 'pty-1', providerGeneration: 7 })

    await expect(queued).rejects.toThrow('ssh_model_migration_queued_canceled')
    expect(admission.getDebugSnapshot()).toMatchObject({ sourceUnits: 4 })
    await expect(
      admission.accept({ ptyId: 'pty-1', providerGeneration: 7 }, 'late', 4, () => ({
        sequence: 8,
        completion: Promise.resolve()
      }))
    ).rejects.toThrow('ssh_model_admission_migrating')

    runningCompletion.resolve()
    await expect(running).resolves.toMatchObject({ sequence: 4 })
    expect(admission.getDebugSnapshot()).toMatchObject({ sourceUnits: 0, bytes: 0 })
  })

  it('cancels a never-settling running entry when its generation closes', async () => {
    const admission = new SshPtyModelAdmission()
    const receipt = accept(admission, new Promise<void>(() => {}))
    const idle = admission.whenIdle({ ptyId: 'pty-1', providerGeneration: 7 })

    admission.closeGeneration(7, 'provider-closed')

    await expect(receipt).rejects.toThrow('provider-closed')
    await expect(idle).resolves.toBeUndefined()
    expect(admission.getDebugSnapshot()).toMatchObject({ sourceUnits: 0, bytes: 0 })
  })

  it('cancels a never-settling running entry on disposal', async () => {
    const admission = new SshPtyModelAdmission()
    const receipt = accept(admission, new Promise<void>(() => {}))
    const idle = admission.whenIdle({ ptyId: 'pty-1', providerGeneration: 7 })

    admission.dispose()

    await expect(receipt).rejects.toThrow('ssh_model_admission_disposed')
    await expect(idle).resolves.toBeUndefined()
    expect(admission.getDebugSnapshot()).toMatchObject({ sourceUnits: 0, bytes: 0 })
  })

  it('keeps non-migrating callback failure generation-fatal across sibling PTYs', async () => {
    const admission = new SshPtyModelAdmission()
    const failedCompletion = deferred()
    const siblingCompletion = deferred()
    const failed = accept(admission, failedCompletion.promise)
    const sibling = admission.accept({ ptyId: 'pty-2', providerGeneration: 7 }, 'data', 4, () => ({
      sequence: 4,
      completion: siblingCompletion.promise
    }))

    failedCompletion.reject(new Error('emulator failed'))

    await expect(failed).rejects.toThrow('emulator failed')
    await expect(sibling).rejects.toThrow('ssh_model_admission_completion_failed')
    await expect(
      admission.accept({ ptyId: 'pty-3', providerGeneration: 7 }, 'data', 4, () => ({
        sequence: 4,
        completion: Promise.resolve()
      }))
    ).rejects.toThrow('ssh_model_admission_generation_closed')
    expect(admission.getDebugSnapshot()).toMatchObject({ sourceUnits: 0, bytes: 0 })
    siblingCompletion.resolve()
    await Promise.resolve()
    expect(admission.getDebugSnapshot()).toMatchObject({ sourceUnits: 0, bytes: 0 })
  })

  it('resumes every paused provider generation exactly once on disposal', async () => {
    const resumeProvider = vi.fn()
    const admission = new SshPtyModelAdmission({
      perPtyHighSourceUnits: 4,
      perPtyHighBytes: 1024,
      globalHighSourceUnits: 4,
      globalHighBytes: 1024,
      pressureMaxFrames: 1,
      pressureMaxBytes: 1024,
      pauseProvider: () => true,
      resumeProvider
    })
    const running = accept(admission, new Promise<void>(() => {}))
    const pressured = accept(admission, Promise.resolve())
    const rejected = admission.accept({ ptyId: 'pty-2', providerGeneration: 8 }, 'data', 4, () => ({
      sequence: 4,
      completion: Promise.resolve()
    }))

    await expect(rejected).rejects.toThrow('ssh_model_admission_pressure_exhausted')
    admission.dispose()
    admission.dispose()

    await expect(running).rejects.toThrow('ssh_model_admission_disposed')
    await expect(pressured).rejects.toThrow('ssh_model_admission_disposed')
    expect(resumeProvider.mock.calls).toEqual([
      [{ ptyId: 'pty-1', providerGeneration: 7 }],
      [{ ptyId: 'pty-2', providerGeneration: 8 }]
    ])
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a late completion %s after cancellation',
    async (settle) => {
      const completion = deferred()
      const admission = new SshPtyModelAdmission()
      const onResolve = vi.fn()
      const onReject = vi.fn()
      const receipt = accept(admission, completion.promise)
      const observed = receipt.then(onResolve, onReject)

      admission.closeGeneration(7, 'provider-closed')
      await observed
      if (settle === 'resolve') {
        completion.resolve()
      } else {
        completion.reject(new Error('late emulator failure'))
      }
      await Promise.resolve()

      expect(onResolve).not.toHaveBeenCalled()
      expect(onReject).toHaveBeenCalledTimes(1)
      expect(onReject.mock.calls[0]?.[0]).toMatchObject({ message: 'provider-closed' })
      expect(admission.getDebugSnapshot()).toMatchObject({ sourceUnits: 0, bytes: 0 })
    }
  )
})
