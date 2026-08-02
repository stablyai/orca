import { describe, expect, it, vi } from 'vitest'
import { runSerializedWslCliRegistrationOperation } from './wsl-cli-registration-operation'

describe('runSerializedWslCliRegistrationOperation', () => {
  it('serializes operations for distro names with different casing', async () => {
    let releaseFirst!: () => void
    const events: string[] = []
    const first = runSerializedWslCliRegistrationOperation('Ubuntu', async () => {
      events.push('first-start')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      events.push('first-end')
    })

    await vi.waitFor(() => expect(events).toEqual(['first-start']))
    const second = runSerializedWslCliRegistrationOperation(' ubuntu ', async () => {
      events.push('second')
    })
    await Promise.resolve()
    expect(events).toEqual(['first-start'])

    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(['first-start', 'first-end', 'second'])
  })

  it('allows different distros to progress independently', async () => {
    let releaseUbuntu!: () => void
    const events: string[] = []
    const ubuntu = runSerializedWslCliRegistrationOperation('Ubuntu', async () => {
      events.push('ubuntu-start')
      await new Promise<void>((resolve) => {
        releaseUbuntu = resolve
      })
    })
    const debian = runSerializedWslCliRegistrationOperation('Debian', async () => {
      events.push('debian')
    })

    await debian
    expect(events).toEqual(['ubuntu-start', 'debian'])
    releaseUbuntu()
    await ubuntu
  })

  it('releases the queue after an operation fails', async () => {
    await expect(
      runSerializedWslCliRegistrationOperation('Ubuntu', async () => {
        throw new Error('interop failed')
      })
    ).rejects.toThrow('interop failed')

    await expect(
      runSerializedWslCliRegistrationOperation('ubuntu', async () => 'recovered')
    ).resolves.toBe('recovered')
  })
})
