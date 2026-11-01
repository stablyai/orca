import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDeepLinkState } from './orchestration-deep-link-state'

describe('OrchestrationDeepLinkState', () => {
  it('queues a startup orchestration deep link until the renderer consumes it once', () => {
    const state = new OrchestrationDeepLinkState()

    expect(
      state.capture(['orca', 'orca://orchestration/new?title=Startup%20Task&repo=my-project'])
    ).toBe(true)
    expect(state.consume()).toEqual({
      type: 'orchestration-new',
      title: 'Startup Task',
      repo: 'my-project'
    })
    expect(state.consume()).toBeNull()
  })

  it('publishes a later deep link intent and keeps it for renderer recovery', () => {
    const state = new OrchestrationDeepLinkState()
    const publish = vi.fn()

    state.capture(['orca', 'orca://orchestration/new?title=First'])
    expect(
      state.capture(['orca', 'orca://orchestration/run?title=Second&repo=demo-engine'], publish)
    ).toBe(true)

    expect(publish).toHaveBeenCalledWith({
      type: 'orchestration-new',
      title: 'Second',
      repo: 'demo-engine'
    })
    expect(state.consume()).toEqual({
      type: 'orchestration-new',
      title: 'Second',
      repo: 'demo-engine'
    })
  })

  it('clears pending link when publish confirms live delivery', () => {
    const state = new OrchestrationDeepLinkState()
    const publish = vi.fn().mockReturnValue(true)

    expect(
      state.capture(['orca', 'orca://orchestration/new?title=Live&repo=my-project'], publish)
    ).toBe(true)

    expect(publish).toHaveBeenCalledWith({
      type: 'orchestration-new',
      title: 'Live',
      repo: 'my-project'
    })
    expect(state.consume()).toBeNull()
  })

  it('ignores untrusted URLs without replacing a pending intent', () => {
    const state = new OrchestrationDeepLinkState()
    state.capture(['orca', 'orca://orchestration/new?title=Safe'])

    expect(state.capture(['orca', 'https://attacker.test/orchestration/new?title=Evil'])).toBe(
      false
    )
    expect(state.consume()).toEqual({
      type: 'orchestration-new',
      title: 'Safe'
    })
  })
})
