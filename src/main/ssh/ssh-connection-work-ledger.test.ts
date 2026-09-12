import { expect, it } from 'vitest'
import { SshConnectionWorkLedger } from './ssh-connection-work-ledger'

const signal = () => new AbortController().signal

it('allows admitted work to open nested channels after fencing and drains children independently', async () => {
  const ledger = new SshConnectionWorkLedger()
  const continueOperation = Promise.withResolvers<void>()
  let child!: ReturnType<typeof ledger.beginChannelOpen>
  const parent = ledger.run(async () => {
    await continueOperation.promise
    await ledger.run(async () => {
      child = ledger.beginChannelOpen()
      child.bind({})
    })
  })
  const fence = ledger.fenceForReset()
  let drained = false
  const draining = fence.drain(signal()).then(() => {
    drained = true
  })
  continueOperation.resolve()
  await parent
  expect(drained).toBe(false)
  expect(fence.assertDrained).toThrow('ssh_connection_work_not_drained')
  child.close()
  await draining
  fence.assertDrained()
})

it('refuses stale async scope work once its admitted parent has settled', async () => {
  const ledger = new SshConnectionWorkLedger()
  const releaseStale = Promise.withResolvers<void>()
  const staleResult = Promise.withResolvers<unknown>()
  await ledger.run(async () => {
    void releaseStale.promise.then(() => {
      try {
        ledger.beginChannelOpen()
        staleResult.resolve('incorrectly admitted')
      } catch (error) {
        staleResult.resolve(error)
      }
    })
  })
  const fence = ledger.fenceForReset()
  releaseStale.resolve()
  expect(await staleResult.promise).toMatchObject({
    message: 'ssh_connection_work_admission_closed'
  })
  await fence.drain(signal())
})

it('exempts only the exact captured control channel and keeps ordinary admission fenced', async () => {
  const ledger = new SshConnectionWorkLedger()
  const control = ledger.beginChannelOpen()
  const resource = {}
  control.bind(resource)
  const transfer = ledger.beginChannelOpen()
  transfer.bind({})
  expect(() => ledger.fenceForReset({})).toThrow('ssh_connection_work_control_channel_unproven')
  const fence = ledger.fenceForReset(resource)
  expect(() => ledger.beginChannelOpen()).toThrow('ssh_connection_work_admission_closed')
  await expect(ledger.run(async () => undefined)).rejects.toThrow(
    'ssh_connection_work_admission_closed'
  )
  expect(fence.assertDrained).toThrow('ssh_connection_work_not_drained')
  transfer.close()
  await fence.drain(signal())
  fence.assertDrained()
  control.close(new Error('expected reset transport close'))
  fence.assertDrained()
  expect(() => ledger.fenceForReset(resource)).toThrow('ssh_connection_work_already_fenced')
})

it('refuses ambiguous control-channel bindings without publishing a fence', async () => {
  const ledger = new SshConnectionWorkLedger()
  const resource = {}
  const first = ledger.beginChannelOpen()
  const second = ledger.beginChannelOpen()
  first.bind(resource)
  second.bind(resource)
  expect(() => ledger.fenceForReset(resource)).toThrow(
    'ssh_connection_work_control_channel_unproven'
  )
  await ledger.run(async () => undefined)
  second.close()
  await ledger.fenceForReset(resource).drain(signal())
})

it('keeps uncertain pre-fence openings unconfirmed after late channel close', async () => {
  const ledger = new SshConnectionWorkLedger()
  const opening = ledger.beginChannelOpen()
  const uncertainty = new Error('open timed out without closure evidence')
  opening.markUnverifiable(uncertainty)
  const fence = ledger.fenceForReset()
  await expect(fence.drain(signal())).rejects.toBe(uncertainty)
  opening.bind({})
  opening.close()
  expect(fence.assertDrained).toThrow(uncertainty)
  await expect(fence.drain(signal())).rejects.toBe(uncertainty)
})

it('retains operation failures observed while draining', async () => {
  const ledger = new SshConnectionWorkLedger()
  const operation = Promise.withResolvers<void>()
  const failure = new Error('upload failed')
  const running = ledger.run(() => operation.promise).catch((error: unknown) => error)
  const fence = ledger.fenceForReset()
  const draining = fence.drain(signal()).catch((error: unknown) => error)
  operation.reject(failure)
  expect(await running).toBe(failure)
  expect(await draining).toBe(failure)
  expect(fence.assertDrained).toThrow(failure)
  await expect(fence.drain(signal())).rejects.toBe(failure)
})

it('retains a channel failure even after repeated successful close calls', async () => {
  const ledger = new SshConnectionWorkLedger()
  const channel = ledger.beginChannelOpen()
  const fence = ledger.fenceForReset()
  const failure = new Error('channel failed')
  channel.close(failure)
  channel.close()
  expect(fence.assertDrained).toThrow(failure)
  await expect(fence.drain(signal())).rejects.toBe(failure)
})

it('wakes an in-flight drain when an opening becomes unverifiable without waiting for close', async () => {
  const ledger = new SshConnectionWorkLedger()
  const channel = ledger.beginChannelOpen()
  const fence = ledger.fenceForReset()
  const failure = new Error('opening outcome became unverifiable')
  let observed: unknown
  const draining = fence.drain(signal()).catch((error: unknown) => {
    observed = error
  })
  channel.markUnverifiable(failure)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const observedBeforeClose = observed
  channel.close()
  await draining
  expect(observedBeforeClose).toBe(failure)
})

it('reports one failed channel without waiting for unrelated admitted channels to close', async () => {
  const ledger = new SshConnectionWorkLedger()
  const failedChannel = ledger.beginChannelOpen()
  const liveChannel = ledger.beginChannelOpen()
  const fence = ledger.fenceForReset()
  const failure = new Error('selected transfer failed')
  let observed: unknown
  const draining = fence.drain(signal()).catch((error: unknown) => {
    observed = error
  })
  failedChannel.close(failure)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const observedBeforeOtherClose = observed
  liveChannel.close()
  await draining
  expect(observedBeforeOtherClose).toBe(failure)
})

it('cancels only the wait and permits exact drain retry without reopening admission', async () => {
  const ledger = new SshConnectionWorkLedger()
  const opening = ledger.beginChannelOpen()
  const fence = ledger.fenceForReset()
  const controller = new AbortController()
  const cancellation = new Error('user cancelled waiting')
  const draining = fence.drain(controller.signal).catch((error: unknown) => error)
  controller.abort(cancellation)
  expect(await draining).toBe(cancellation)
  expect(fence.assertDrained).toThrow('ssh_connection_work_not_drained')
  expect(() => ledger.beginChannelOpen()).toThrow('ssh_connection_work_admission_closed')
  opening.bind({})
  opening.close()
  await fence.drain(signal())
  fence.assertDrained()
})

it('isolates admission, async ancestry, failures, and control identities between connections', async () => {
  const first = new SshConnectionWorkLedger()
  const second = new SshConnectionWorkLedger()
  const resource = {}
  first.beginChannelOpen().bind(resource)
  const firstFence = first.fenceForReset(resource)
  await second.run(async () => {
    expect(() => first.beginChannelOpen()).toThrow('ssh_connection_work_admission_closed')
  })
  expect(() => second.fenceForReset(resource)).toThrow(
    'ssh_connection_work_control_channel_unproven'
  )
  const channel = second.beginChannelOpen()
  const secondFence = second.fenceForReset()
  channel.close(new Error('second connection failure'))
  await expect(secondFence.drain(signal())).rejects.toThrow('second connection failure')
  await firstFence.drain(signal())
})

it('rejects rebinding and binding an already settled opening', () => {
  const ledger = new SshConnectionWorkLedger()
  const channel = ledger.beginChannelOpen()
  channel.bind({})
  expect(() => channel.bind({})).toThrow('ssh_connection_work_channel_binding_changed')
  const closed = ledger.beginChannelOpen()
  closed.close()
  expect(() => closed.bind({})).toThrow('ssh_connection_work_channel_binding_changed')
})

it.each([false, true])(
  'preserves drained proof after exact exempt control closes (error=%s)',
  async (withError) => {
    const ledger = new SshConnectionWorkLedger()
    const control = ledger.beginChannelOpen()
    const resource = {}
    control.bind(resource)
    const fence = ledger.fenceForReset(resource)
    await fence.drain(signal())
    if (withError) {
      control.markUnverifiable(new Error('control stream closed after response'))
    }
    control.close(withError ? new Error('control closed') : undefined)
    fence.assertDrained()
    await fence.drain(signal())
    expect(() => ledger.beginChannelOpen()).toThrow('admission_closed')
  }
)

it('control closure cannot erase retained unrelated work or transport failure', async () => {
  for (const transportFailure of [false, true]) {
    const ledger = new SshConnectionWorkLedger()
    const control = ledger.beginChannelOpen()
    const resource = {}
    control.bind(resource)
    const work = ledger.beginChannelOpen()
    const fence = ledger.fenceForReset(resource)
    if (transportFailure) {
      work.close()
      await fence.drain(signal())
      ledger.markTransportUnverifiable()
    } else {
      work.close(new Error('unrelated write failed'))
    }
    control.close()
    expect(fence.assertDrained).toThrow(
      transportFailure ? 'transport_unverifiable' : 'unrelated write failed'
    )
    await expect(fence.drain(signal())).rejects.toThrow()
  }
})
