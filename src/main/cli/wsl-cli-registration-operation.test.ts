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
})
