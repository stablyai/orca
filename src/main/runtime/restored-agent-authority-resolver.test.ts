import { describe, expect, it } from 'vitest'
import {
  RestoredAgentAuthorityResolver,
  type RestoredAgentAuthorityBinding,
  type RestoredAgentAuthorityHook
} from './restored-agent-authority-resolver'

const hook: RestoredAgentAuthorityHook = {
  identity: 'hook-a',
  paneKey: 'tab-a:leaf-a',
  worktreeKey: 'repo-a\0/worktree-a',
  hostKey: 'ssh:host-a'
}

function binding(
  overrides: Partial<RestoredAgentAuthorityBinding> = {}
): RestoredAgentAuthorityBinding {
  return {
    ptyId: 'pty-a',
    incarnationId: 'incarnation-a',
    lifecycleGeneration: 1,
    source: 'current',
    paneKey: hook.paneKey,
    worktreeKey: hook.worktreeKey,
    hostKey: hook.hostKey,
    ...overrides
  }
}

describe('RestoredAgentAuthorityResolver', () => {
  it('rejects current process evidence from another execution host', () => {
    const resolver = new RestoredAgentAuthorityResolver()

    expect(
      resolver.resolve({
        hook,
        current: binding({ hostKey: 'local' }),
        persisted: null
      })
    ).toEqual({ binding: null, hasExactBinding: false })
  })

  it('keeps one hook fenced to its first process incarnation', () => {
    const resolver = new RestoredAgentAuthorityResolver()
    expect(
      resolver.resolve({
        hook,
        current: binding(),
        persisted: binding({ source: 'persisted' })
      }).binding
    ).toEqual(binding())

    expect(
      resolver.resolve({
        hook,
        current: binding({ incarnationId: 'incarnation-b' }),
        persisted: null
      })
    ).toEqual({ binding: null, hasExactBinding: false })
  })

  it('treats lifecycle generations as fallback identity when incarnation exists', () => {
    const resolver = new RestoredAgentAuthorityResolver()
    resolver.resolve({
      hook,
      current: binding(),
      persisted: binding({ source: 'persisted' })
    })

    expect(
      resolver.resolve({
        hook,
        current: binding({ lifecycleGeneration: 2 }),
        persisted: null
      }).binding
    ).toEqual(binding({ lifecycleGeneration: 2 }))
  })

  it('does not confuse a generation-shaped incarnation with fallback identity', () => {
    const resolver = new RestoredAgentAuthorityResolver()
    resolver.resolve({
      hook,
      current: binding({ incarnationId: null, lifecycleGeneration: 1 }),
      persisted: binding({
        incarnationId: null,
        lifecycleGeneration: 1,
        source: 'persisted'
      })
    })

    expect(
      resolver.resolve({
        hook,
        current: binding({ incarnationId: 'generation:1', lifecycleGeneration: 99 }),
        persisted: null
      })
    ).toEqual({ binding: null, hasExactBinding: false })
  })

  it('keeps process authority stable when a terminal handle is learned', () => {
    const resolver = new RestoredAgentAuthorityResolver()
    resolver.resolve({
      hook,
      current: binding(),
      persisted: binding({ source: 'persisted' })
    })

    expect(
      resolver.resolve({
        hook,
        current: binding({ terminalHandle: 'term_learned' }),
        persisted: null
      }).binding
    ).toEqual(binding({ terminalHandle: 'term_learned' }))
  })

  it('uses a hook terminal handle as a constraint when one is present', () => {
    const resolver = new RestoredAgentAuthorityResolver()
    const handleHook = { ...hook, terminalHandle: 'term_expected' }

    expect(
      resolver.resolve({
        hook: handleHook,
        current: binding({ terminalHandle: 'term_other' }),
        persisted: null
      })
    ).toEqual({ binding: null, hasExactBinding: false })
  })

  it('requires persisted authority before accepting a current binding', () => {
    const resolver = new RestoredAgentAuthorityResolver()

    expect(resolver.resolve({ hook, current: binding(), persisted: null })).toEqual({
      binding: null,
      hasExactBinding: false
    })
  })

  it('seeds from persisted authority and later accepts matching current authority', () => {
    const resolver = new RestoredAgentAuthorityResolver()
    const persisted = binding({ source: 'persisted' })

    expect(resolver.resolve({ hook, current: null, persisted })).toEqual({
      binding: persisted,
      hasExactBinding: true
    })
    expect(resolver.resolve({ hook, current: binding(), persisted: null }).binding).toEqual(
      binding()
    )
  })

  it('does not let a replacement current binding borrow first authority', () => {
    const resolver = new RestoredAgentAuthorityResolver()

    expect(
      resolver.resolve({
        hook,
        current: binding({ ptyId: 'pty-replacement', incarnationId: 'incarnation-b' }),
        persisted: binding({ source: 'persisted' })
      })
    ).toEqual({ binding: null, hasExactBinding: false })
  })

  it('rejects disagreement between current and persisted bindings', () => {
    const resolver = new RestoredAgentAuthorityResolver()

    expect(
      resolver.resolve({
        hook,
        current: binding({ incarnationId: 'incarnation-b' }),
        persisted: binding({ source: 'persisted' })
      })
    ).toEqual({ binding: null, hasExactBinding: false })
  })

  it('forgets commitments after their restored hook disappears', () => {
    const resolver = new RestoredAgentAuthorityResolver()
    resolver.resolve({
      hook,
      current: binding(),
      persisted: binding({ source: 'persisted' })
    })
    resolver.retain(new Set())

    const replacement = binding({ incarnationId: 'incarnation-b', source: 'persisted' })
    expect(
      resolver.resolve({
        hook,
        current: null,
        persisted: replacement
      }).binding
    ).toEqual(replacement)
  })
})
