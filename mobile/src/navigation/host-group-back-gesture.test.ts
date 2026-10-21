import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { rootOwnsHostGroupBackGesture } from './host-group-back-gesture'

const hostRoute = (name: string) => ({ key: `${name}-key`, name })

describe('rootOwnsHostGroupBackGesture', () => {
  it('keeps the root swipe before the host stack has any state', () => {
    expect(rootOwnsHostGroupBackGesture({ key: 'h-key', name: 'h' })).toBe(true)
    expect(rootOwnsHostGroupBackGesture({ key: 'h-key', name: 'h', state: undefined })).toBe(true)
  })

  it('keeps the root swipe while the host stack is on its first screen', () => {
    const state = { index: 0, routes: [hostRoute('[hostId]/session/[worktreeId]')] }
    expect(rootOwnsHostGroupBackGesture({ key: 'h-key', name: 'h', state })).toBe(true)
  })

  it('hands the swipe to the host stack once a screen is pushed inside it', () => {
    const state = {
      index: 1,
      routes: [hostRoute('[hostId]/session/[worktreeId]'), hostRoute('[hostId]/files/[worktreeId]')]
    }
    expect(rootOwnsHostGroupBackGesture({ key: 'h-key', name: 'h', state })).toBe(false)
  })

  it('reads the focused index, not the route count', () => {
    const state = {
      index: 0,
      routes: [hostRoute('[hostId]/index'), hostRoute('[hostId]/session/[worktreeId]')]
    }
    expect(rootOwnsHostGroupBackGesture({ key: 'h-key', name: 'h', state })).toBe(true)
  })

  it('takes the last route of a partial state as focused', () => {
    const deep = { routes: [hostRoute('[hostId]/index'), hostRoute('[hostId]/files/[worktreeId]')] }
    const shallow = { routes: [hostRoute('[hostId]/index')] }
    expect(rootOwnsHostGroupBackGesture({ key: 'h-key', name: 'h', state: deep })).toBe(false)
    expect(rootOwnsHostGroupBackGesture({ key: 'h-key', name: 'h', state: shallow })).toBe(true)
  })

  it('gates the root layout h screen', () => {
    // Source-pinned: vitest only collects src/, so app/_layout.tsx has no runtime coverage.
    const layout = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8')
    expect(layout).toMatch(
      /name="h"\s+options=\{\(\{ route \}\) => \(\{[^}]*gestureEnabled: rootOwnsHostGroupBackGesture\(route\)/
    )
  })
})
