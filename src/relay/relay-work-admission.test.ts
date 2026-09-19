import { describe, expect, it, vi } from 'vitest'
import type { RequestContext } from './dispatcher-contract'
import { RelayWorkAdmission } from './relay-work-admission'
import { RELAY_PREPARED_RESET_RECOVERY_METHOD } from '../shared/relay-owner-reset-contract'

function context(): RequestContext {
  return { clientId: 1, transportGeneration: 1, isStale: () => false }
}

function pendingOperation() {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('RelayWorkAdmission', () => {
  it('starts admitted operations synchronously and preserves their result', async () => {
    const admission = new RelayWorkAdmission()
    const operation = vi.fn(() => 'started')
    const result = admission.run('fs.writeFile', context(), operation)
    expect(operation).toHaveBeenCalledOnce()
    await expect(result).resolves.toBe('started')
  })

  it('closes admission synchronously and drains existing work despite abort and disconnect', async () => {
    const admission = new RelayWorkAdmission()
    const controller = new AbortController()
    let disconnected = false
    const mutation = pendingOperation()
    const running = admission.run(
      'fs.writeFile',
      { ...context(), signal: controller.signal, isStale: () => disconnected },
      () => mutation.promise
    )
    const drained = vi.fn()
    const drain = admission.beginDrain().then(drained)
    const rejectedOperation = vi.fn()
    await expect(admission.run('fs.writeFile', context(), rejectedOperation)).rejects.toThrow(
      'relay_work_admission_closed'
    )
    expect(rejectedOperation).not.toHaveBeenCalled()
    controller.abort()
    disconnected = true
    await nextTurn()
    expect(drained).not.toHaveBeenCalled()
    mutation.resolve()
    await running
    await drain
    expect(drained).toHaveBeenCalledOnce()
  })

  it.each([
    'relay.status',
    'relay.reset',
    RELAY_PREPARED_RESET_RECOVERY_METHOD,
    'fs.unwatchAndWait',
    'agent.cancelExec'
  ])('admits cleanup request %s while draining', async (method) => {
    const admission = new RelayWorkAdmission()
    const mutation = pendingOperation()
    const running = admission.run('git.diff', context(), () => mutation.promise)
    const drain = admission.beginDrain()
    await expect(
      admission.run(method, context(), () => {
        mutation.resolve()
        return 'acknowledged'
      })
    ).resolves.toBe('acknowledged')
    await running
    await drain
  })

  it.each([
    'rpc.cancel',
    'git.responseAck',
    'git.cancelResponseStream',
    'fs.streamAck',
    'fs.cancelStream',
    'fs.unwatch',
    'pty.ackData',
    'pty.setDeliveryPaused'
  ])('admits cleanup notification %s while draining', async (method) => {
    const admission = new RelayWorkAdmission()
    const mutation = pendingOperation()
    const running = admission.run('git.diff', context(), () => mutation.promise)
    const drain = admission.beginDrain()
    const acknowledge = vi.fn(() => mutation.resolve())
    admission.runNotification(method, context(), acknowledge)
    expect(acknowledge).toHaveBeenCalledOnce()
    await running
    await drain
    await expect(admission.run('git.diff', context(), () => {})).rejects.toThrow(
      'relay_work_admission_closed'
    )
  })

  it('excludes the exact reset request without excluding another request from the same client', async () => {
    const admission = new RelayWorkAdmission()
    const mutation = pendingOperation()
    const running = admission.run('fs.writeFile', context(), () => mutation.promise)
    const resetContext = context()
    const drained = vi.fn()
    const reset = admission.run('relay.reset', resetContext, async () => {
      await admission.beginDrain(resetContext)
      drained()
    })
    await nextTurn()
    expect(drained).not.toHaveBeenCalled()
    mutation.resolve()
    await running
    await reset
    expect(drained).toHaveBeenCalledOnce()
  })

  it('rejects a forged context without closing admission', async () => {
    const admission = new RelayWorkAdmission()
    const actualContext = context()
    await admission.run('relay.reset', actualContext, async () => {
      await expect(admission.beginDrain({ ...actualContext })).rejects.toThrow(
        'relay_work_drain_context_not_active'
      )
      await expect(admission.run('fs.writeFile', context(), () => 'open')).resolves.toBe('open')
    })
  })

  it('rejects an already-settled request context without closing admission', async () => {
    const admission = new RelayWorkAdmission()
    const oldContext = context()
    await admission.run('relay.reset', oldContext, () => {})
    await expect(admission.beginDrain(oldContext)).rejects.toThrow(
      'relay_work_drain_context_not_active'
    )
    await expect(admission.run('fs.writeFile', context(), () => 'open')).resolves.toBe('open')
  })

  it('waits for reset work when the host lifecycle supplies no exclusion', async () => {
    const admission = new RelayWorkAdmission()
    const mutation = pendingOperation()
    const reset = admission.run('relay.reset', context(), () => mutation.promise)
    const drained = vi.fn()
    const drain = admission.beginDrain().then(drained)
    await nextTurn()
    expect(drained).not.toHaveBeenCalled()
    mutation.resolve()
    await reset
    await drain
    expect(drained).toHaveBeenCalledOnce()
  })

  it('drops new mutation notifications without invoking their handlers during drain', async () => {
    const admission = new RelayWorkAdmission()
    await admission.beginDrain()
    const mutate = vi.fn()
    admission.runNotification('pty.write', context(), mutate)
    expect(mutate).not.toHaveBeenCalled()
    await expect(admission.run('pty.ackData', context(), mutate)).rejects.toThrow(
      'relay_work_admission_closed'
    )
  })

  it('tracks asynchronous notifications through settlement while draining', async () => {
    const admission = new RelayWorkAdmission()
    const mutation = pendingOperation()
    const operation = vi.fn(async () => mutation.promise)
    admission.runNotification('pty.write', context(), operation)
    expect(operation).toHaveBeenCalledOnce()
    const drained = vi.fn()
    const drain = admission.beginDrain().then(drained)
    await nextTurn()
    expect(drained).not.toHaveBeenCalled()
    mutation.resolve()
    await drain
    expect(drained).toHaveBeenCalledOnce()
  })

  it('releases tracking after synchronous notification failure', async () => {
    const admission = new RelayWorkAdmission()
    expect(() =>
      admission.runNotification('pty.write', context(), () => {
        throw new Error('notification_failed')
      })
    ).toThrow('notification_failed')
    await admission.beginDrain()
    const mutate = vi.fn()
    admission.runNotification('pty.write', context(), mutate)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('settles concurrent drains after an admitted operation fails without reopening', async () => {
    const admission = new RelayWorkAdmission()
    const mutation = pendingOperation()
    const running = admission.run('fs.writeFile', context(), async () => {
      await mutation.promise
      throw new Error('write_failed')
    })
    const failure = expect(running).rejects.toThrow('write_failed')
    const firstDrain = admission.beginDrain()
    const secondDrain = admission.beginDrain()
    mutation.resolve()
    await failure
    await Promise.all([firstDrain, secondDrain])
    await expect(admission.run('fs.writeFile', context(), () => {})).rejects.toThrow(
      'relay_work_admission_closed'
    )
  })

  it('turns synchronous operation failures into rejected promises and releases tracking', async () => {
    const admission = new RelayWorkAdmission()
    const result = admission.run('fs.writeFile', context(), () => {
      throw new Error('write_failed')
    })
    await expect(result).rejects.toThrow('write_failed')
    await admission.beginDrain()
    await expect(admission.run('fs.writeFile', context(), () => {})).rejects.toThrow(
      'relay_work_admission_closed'
    )
  })
})
