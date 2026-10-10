import { beforeEach, describe, expect, it } from 'vitest'
import {
  __resetLocalWorktreeMetadataPruneGateForTests,
  forgetLocalWorktreeMetadataPruneGate,
  invalidateLocalWorktreeMetadataPruneInputs,
  isLocalWorktreeMetadataPruneDue,
  markLocalWorktreeMetadataPruneStarted,
  recordLocalWorktreeListingForPruneGate,
  requireLocalWorktreeMetadataPrune
} from './local-worktree-metadata-prune-gate'

describe('local worktree metadata prune gate', () => {
  beforeEach(() => {
    __resetLocalWorktreeMetadataPruneGateForTests()
  })

  it('is due for a repo it has never seen', () => {
    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(true)
  })

  it('stays undue indefinitely once a pass ran and nothing changed', () => {
    markLocalWorktreeMetadataPruneStarted('repo-1')

    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(false)
    recordLocalWorktreeListingForPruneGate('repo-1', ['/a', '/b'])
    recordLocalWorktreeListingForPruneGate('repo-1', ['/b', '/a'])
    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(false)
  })

  it('re-arms one repo on its own worktree lifecycle event', () => {
    markLocalWorktreeMetadataPruneStarted('repo-1')
    markLocalWorktreeMetadataPruneStarted('repo-2')

    requireLocalWorktreeMetadataPrune('repo-1')

    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(true)
    expect(isLocalWorktreeMetadataPruneDue('repo-2')).toBe(false)
  })

  it('re-arms every repo when ownership state may have released a row', () => {
    markLocalWorktreeMetadataPruneStarted('repo-1')
    markLocalWorktreeMetadataPruneStarted('repo-2')

    invalidateLocalWorktreeMetadataPruneInputs()

    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(true)
    expect(isLocalWorktreeMetadataPruneDue('repo-2')).toBe(true)
  })

  it('runs each repo once per invalidation, not once per scan', () => {
    invalidateLocalWorktreeMetadataPruneInputs()
    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(true)
    markLocalWorktreeMetadataPruneStarted('repo-1')

    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(false)
    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(false)
  })

  it('does not re-arm on the first listing it observes', () => {
    markLocalWorktreeMetadataPruneStarted('repo-1')

    recordLocalWorktreeListingForPruneGate('repo-1', ['/a'])

    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(false)
  })

  it('re-arms when a later listing differs from the one the last pass ran against', () => {
    recordLocalWorktreeListingForPruneGate('repo-1', ['/a', '/b'])
    markLocalWorktreeMetadataPruneStarted('repo-1')

    recordLocalWorktreeListingForPruneGate('repo-1', ['/a'])

    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(true)
  })

  it('drops gate state for a deregistered repo', () => {
    recordLocalWorktreeListingForPruneGate('repo-1', ['/a'])
    markLocalWorktreeMetadataPruneStarted('repo-1')

    forgetLocalWorktreeMetadataPruneGate('repo-1')

    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(true)
    // The forgotten fingerprint must not later read as a change against a stale entry.
    recordLocalWorktreeListingForPruneGate('repo-1', ['/a'])
    markLocalWorktreeMetadataPruneStarted('repo-1')
    expect(isLocalWorktreeMetadataPruneDue('repo-1')).toBe(false)
  })
})
