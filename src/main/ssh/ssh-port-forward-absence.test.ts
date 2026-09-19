import { describe, expect, it, vi } from 'vitest'
import { SshPortForwardAdmission } from './ssh-port-forward-admission'
import { SshPortForwardRetirementCohort } from './ssh-port-forward-retirement-cohort'
import { SshPortForwardManager } from './ssh-port-forward'
import type { SshConnection } from './ssh-connection'
import type { PortForwardStartOptions, StartedPortForward } from './ssh-port-forward-provider'

function resource(connectionId = 'target'): StartedPortForward {
  return {
    entry: {
      id: 'forward',
      connectionId,
      localPort: 3000,
      remoteHost: 'localhost',
      remotePort: 4000
    },
    close: vi.fn(async () => {}),
    dispose: vi.fn(),
    fenceForDrain: () => ({ drain: async () => {}, assertDrained: () => {} })
  }
}

describe('forward admission absence', () => {
  it('observes pending publication before its operation callback and isolates targets', async () => {
    const admission = new SshPortForwardAdmission()
    admission.assertAbsent('target')
    const gate = Promise.withResolvers<void>()
    const pending = admission.run('target', () => {
      expect(() => admission.assertAbsent('target')).toThrow('still_retained')
      admission.assertAbsent('other')
      return gate.promise
    })
    expect(() => admission.assertAbsent('target')).toThrow('still_retained')
    gate.resolve()
    await pending
    admission.assertAbsent('target')
  })

  it('retains a drained fence until explicitly released', async () => {
    const admission = new SshPortForwardAdmission()
    const fence = admission.fence('target')
    await fence.drain()
    expect(() => admission.assertAbsent('target')).toThrow('still_retained')
    admission.assertAbsent('other')
    fence.release(() => {})
    admission.assertAbsent('target')
  })
})

describe('forward retirement absence', () => {
  it('accepts empty state but rejects pending reservations and starts', async () => {
    const cohort = new SshPortForwardRetirementCohort()
    cohort.assertAbsent()
    const reservation = cohort.reserveStart()
    expect(() => cohort.assertAbsent()).toThrow('still_retained')
    const gate = Promise.withResolvers<StartedPortForward>()
    const pending = reservation.start(() => gate.promise)
    expect(() => cohort.assertAbsent()).toThrow('still_retained')
    const selected = resource()
    Object.assign(selected, { retirementConfirmed: true })
    gate.resolve(selected)
    await pending
    expect(() => cohort.assertAbsent()).toThrow('still_retained')
    reservation.release()
    cohort.assertAbsent()
  })

  it('does not treat successful close as complete retirement', async () => {
    const cohort = new SshPortForwardRetirementCohort()
    const selected = resource()
    cohort.register(selected)
    await selected.close()
    expect(() => cohort.assertAbsent()).toThrow('still_retained')
    Object.assign(selected, { retirementConfirmed: true })
    cohort.assertAbsent()
    expect(cohort.isEmpty).toBe(false)
    expect(selected.close).toHaveBeenCalledOnce()
    expect(selected.dispose).not.toHaveBeenCalled()
  })

  it('preserves failed evidence even with no retained instances', () => {
    const cohort = new SshPortForwardRetirementCohort()
    cohort.fail(new Error('unverifiable traffic'))
    expect(() => cohort.assertAbsent()).toThrow('unverifiable traffic')
    expect(cohort.isEmpty).toBe(true)
  })

  it('refuses an empty fenced cohort', async () => {
    const cohort = new SshPortForwardRetirementCohort()
    await cohort.fenceForDrain().drain(new AbortController().signal)
    expect(() => cohort.assertAbsent()).toThrow('still_retained')
  })

  it('rechecks evidence after a receipt getter', () => {
    const cohort = new SshPortForwardRetirementCohort()
    const selected = resource()
    cohort.register(selected)
    Object.defineProperty(selected, 'retirementConfirmed', {
      get: () => {
        cohort.fail(new Error('receipt changed evidence'))
        return true
      }
    })
    expect(() => cohort.assertAbsent()).toThrow('receipt changed evidence')
  })

  it('rejects a reservation created while reading a retirement receipt', () => {
    const cohort = new SshPortForwardRetirementCohort()
    const selected = resource()
    cohort.register(selected)
    let entered = false
    let reservation: ReturnType<SshPortForwardRetirementCohort['reserveStart']> | undefined
    Object.defineProperty(selected, 'retirementConfirmed', {
      get: () => {
        if (!entered) {
          entered = true
          reservation = cohort.reserveStart()
        }
        return true
      }
    })
    expect(() => cohort.assertAbsent()).toThrow('retirement_changed')
    reservation?.release()
  })
})

function managerFixture() {
  const selected = resource()
  let options: PortForwardStartOptions | undefined
  const start = vi.fn(async (_conn: SshConnection, value: PortForwardStartOptions) => {
    options = value
    Object.assign(selected.entry, { id: value.id, connectionId: value.connectionId })
    return selected
  })
  const manager = new SshPortForwardManager({}, [{ canHandle: () => true, start }])
  const add = (target = 'target') =>
    manager.addForward(target, {} as SshConnection, 3000, 'localhost', 4000)
  return { manager, selected, start, add, options: () => options! }
}

describe('manager target resource absence', () => {
  it('accepts empty state and isolates another target with an active forward', async () => {
    const { manager, add } = managerFixture()
    manager.assertTargetResourcesAbsent('target')
    await add()
    expect(() => manager.assertTargetResourcesAbsent('target')).toThrow('target_still_retained')
    manager.assertTargetResourcesAbsent('other')
  })

  it('rejects pending provider startup before visible publication', async () => {
    const { manager, start, selected, add } = managerFixture()
    const gate = Promise.withResolvers<StartedPortForward>()
    start.mockImplementationOnce(() => gate.promise)
    const pending = add()
    expect(manager.listForwards('target')).toEqual([])
    expect(() => manager.assertTargetResourcesAbsent('target')).toThrow('admission_still_retained')
    manager.assertTargetResourcesAbsent('other')
    gate.resolve(selected)
    await pending
  })

  it('retains disposed resources after they disappear from the visible list', async () => {
    const { manager, selected, add } = managerFixture()
    const entry = await add()
    manager.removeForward(entry.id)
    expect(manager.listForwards('target')).toEqual([])
    expect(() => manager.assertTargetResourcesAbsent('target')).toThrow('retirement_still_retained')
    Object.assign(selected, { retirementConfirmed: true })
    manager.assertTargetResourcesAbsent('target')
    expect(selected.dispose).toHaveBeenCalledOnce()
    expect(selected.close).not.toHaveBeenCalled()
  })

  it('preserves unexpected-close evidence after visible removal and retirement confirmation', async () => {
    const { manager, selected, add, options } = managerFixture()
    await add()
    options().onUnexpectedClose?.(selected.entry, { kind: 'unexpected-exit', detail: 'lost owner' })
    expect(manager.listForwards('target')).toEqual([])
    Object.assign(selected, { retirementConfirmed: true })
    expect(() => manager.assertTargetResourcesAbsent('target')).toThrow('lost owner')
    manager.assertTargetResourcesAbsent('other')
  })

  it('requires explicit release of a drained empty admission fence', async () => {
    const { manager } = managerFixture()
    const fence = manager.fenceForwardAdmission('target')
    await fence.drain()
    expect(() => manager.assertTargetResourcesAbsent('target')).toThrow('admission_still_retained')
    fence.release(() => {})
    manager.assertTargetResourcesAbsent('target')
  })
})
