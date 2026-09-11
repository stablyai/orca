import { expect, it } from 'vitest'
import type { RuntimeTerminalOrphanAdoptionRequest } from '../../shared/runtime-types'
import { validateRuntimeTerminalOrphanTopology } from './runtime-terminal-orphan-topology-validation'

function fixture(count: number): RuntimeTerminalOrphanAdoptionRequest {
  const ids = Array.from({ length: count }, (_, index) => `tab-${index}`)
  return {
    worktree: 'folder-workspace',
    expectedTopologyRevision: 1,
    claims: ids.map((tabId) => ({
      tabId,
      leafId: tabId,
      terminal: tabId,
      ptyId: tabId,
      incarnationId: tabId
    })) as RuntimeTerminalOrphanAdoptionRequest['claims'],
    topology: {
      tabs: ids.map((tabId) => ({
        tabId,
        root: { type: 'leaf', leafId: tabId },
        activeLeafId: tabId,
        expandedLeafId: null
      })),
      groups: [{ id: 'g', activeTabId: ids[0], tabOrder: ids, recentTabIds: ids.toReversed() }]
    }
  }
}

it('validates large restored MRU lists with linear tab-order reads', () => {
  const request = fixture(1000)
  let reads = 0
  const group = request.topology!.groups[0]
  group.tabOrder = new Proxy(group.tabOrder, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads += 1
      }
      return Reflect.get(target, key, receiver)
    }
  })
  expect(
    validateRuntimeTerminalOrphanTopology(
      request,
      request.claims.map((claim) => ({ claim }))
    ).topologyTabsById.size
  ).toBe(1000)
  expect(reads).toBeLessThanOrEqual(3000)
})

it.each(['duplicate', 'foreign-recent', 'foreign-active'])(
  'rejects %s group membership',
  (kind) => {
    const request = fixture(2)
    const group = request.topology!.groups[0]
    if (kind === 'duplicate') {
      group.tabOrder.push(group.tabOrder[0])
    }
    if (kind === 'foreign-recent') {
      group.recentTabIds = ['foreign']
    }
    if (kind === 'foreign-active') {
      group.activeTabId = 'foreign'
    }
    expect(() =>
      validateRuntimeTerminalOrphanTopology(
        request,
        request.claims.map((claim) => ({ claim }))
      )
    ).toThrow('terminal_orphan_topology_invalid')
  }
)

function validate(request: RuntimeTerminalOrphanAdoptionRequest) {
  return validateRuntimeTerminalOrphanTopology(
    request,
    request.claims.map((claim) => ({ claim }))
  )
}

type Groups = NonNullable<RuntimeTerminalOrphanAdoptionRequest['topology']>['groups']

function withGroups(count: number, groups: Groups): RuntimeTerminalOrphanAdoptionRequest {
  const request = fixture(count)
  request.topology!.groups = groups
  return request
}

// Membership is per-group, but the no-tab-in-two-groups rule is global. Replacing that rule with
// the per-group set would let one pane be adopted into two groups and cross-wire the session.
it('rejects a tab claimed by two different groups', () => {
  expect(() =>
    validate(
      withGroups(2, [
        { id: 'g1', activeTabId: 'tab-0', tabOrder: ['tab-0', 'tab-1'], recentTabIds: [] },
        { id: 'g2', activeTabId: 'tab-1', tabOrder: ['tab-1'], recentTabIds: [] }
      ])
    )
  ).toThrow('terminal_orphan_topology_invalid')
})

it('rejects a duplicated group id', () => {
  expect(() =>
    validate(
      withGroups(2, [
        { id: 'g', activeTabId: 'tab-0', tabOrder: ['tab-0'], recentTabIds: [] },
        { id: 'g', activeTabId: 'tab-1', tabOrder: ['tab-1'], recentTabIds: [] }
      ])
    )
  ).toThrow('terminal_orphan_topology_invalid')
})

// Cardinality 0: an empty tab order can never hold the active tab, so adoption must fail closed
// rather than fall through to an arbitrary pane.
it('rejects an empty tab order', () => {
  expect(() =>
    validate(withGroups(2, [{ id: 'g', activeTabId: 'tab-0', tabOrder: [], recentTabIds: [] }]))
  ).toThrow('terminal_orphan_topology_invalid')
})

it('rejects a claimed tab that no group lists', () => {
  expect(() =>
    validate(
      withGroups(2, [{ id: 'g', activeTabId: 'tab-0', tabOrder: ['tab-0'], recentTabIds: [] }])
    )
  ).toThrow('terminal_orphan_topology_invalid')
})

it.each([
  ['1 tab per group', [['tab-0'], ['tab-1']]],
  ['both tabs in one group', [['tab-0', 'tab-1']]]
])('accepts an exactly-covering split with %s', (_label, tabOrders) => {
  const groups: Groups = tabOrders.map((tabOrder, i) => ({
    id: `g${i}`,
    activeTabId: tabOrder[0],
    tabOrder,
    // Reverse MRU: every entry must still resolve inside its own group.
    recentTabIds: tabOrder.toReversed()
  }))
  expect(validate(withGroups(2, groups)).topologyTabsById.size).toBe(2)
})

it.each([
  ['omitted', undefined],
  ['empty', [] as string[]]
])('accepts %s recentTabIds', (_label, recentTabIds) => {
  expect(
    validate(
      withGroups(2, [{ id: 'g', activeTabId: 'tab-0', tabOrder: ['tab-0', 'tab-1'], recentTabIds }])
    ).topologyTabsById.size
  ).toBe(2)
})
