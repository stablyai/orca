import { afterEach, expect, it } from 'vitest'
import {
  notifyWorktreeActivity,
  onRepoActivity,
  type RepoActivitySubscription
} from './worktree-activity-signal'

// Perf contract (STA-18213, #48030): each shell completion or agent turn called every git-common owner, which then
// filtered by repo, so 100 owners cost 99 wasted callbacks per event.

let subscriptions: RepoActivitySubscription[] = []

afterEach(() => {
  for (const subscription of subscriptions) {
    subscription.unsubscribe()
  }
  subscriptions = []
})

function startOwners(count: number): { calls: number[] } {
  const calls = Array.from({ length: count }, () => 0)
  for (let owner = 0; owner < count; owner += 1) {
    const subscription = onRepoActivity(() => {
      calls[owner] += 1
    })
    subscription.setRepoIds([`repo-${owner}`])
    subscriptions.push(subscription)
  }
  return { calls }
}

function totalCalls(calls: number[]): number {
  return calls.reduce((sum, count) => sum + count, 0)
}

it.each([10, 100])('calls only the owning listener per event at %i owners', (owners) => {
  const { calls } = startOwners(owners)
  for (let event = 0; event < 100; event += 1) {
    notifyWorktreeActivity(`repo-3::/work/tree-${event}`)
  }
  expect(totalCalls(calls)).toBe(100)
  expect(calls[3]).toBe(100)
})

it('follows membership changes and stops after unsubscribe', () => {
  const { calls } = startOwners(10)
  subscriptions[0].setRepoIds(['repo-0', 'repo-added'])
  subscriptions[1].setRepoIds([])
  notifyWorktreeActivity('repo-added::/a')
  notifyWorktreeActivity('repo-1::/b')
  expect(calls[0]).toBe(1)
  expect(totalCalls(calls)).toBe(1)
  subscriptions[0].unsubscribe()
  notifyWorktreeActivity('repo-0::/c')
  notifyWorktreeActivity('repo-added::/d')
  expect(totalCalls(calls)).toBe(1)
})
