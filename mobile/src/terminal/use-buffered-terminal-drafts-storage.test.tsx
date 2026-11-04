import { createElement, useEffect, useRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useBufferedTerminalDrafts } from './use-buffered-terminal-drafts'

const disk = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => disk.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      disk.set(key, value)
    }),
    removeItem: vi.fn(async (key: string) => {
      disk.delete(key)
    })
  }
}))

const key = 'orca:terminalDrafts:host:folder-workspace'
let current: ReturnType<typeof useBufferedTerminalDrafts> | null = null
let tree: ReactTestRenderer | null = null
function Probe({ scope = 'paired', handle = 'terminal-a' }: { scope?: string; handle?: string }) {
  const activeHandleRef = useRef<string | null>(handle)
  useEffect(() => {
    activeHandleRef.current = handle
  }, [handle])
  current = useBufferedTerminalDrafts({
    activeHandle: handle,
    activeHandleRef,
    storageKey: key,
    storageScope: scope
  })
  useEffect(() => {
    current?.resetDrafts()
  }, [])
  return null
}
function hook() {
  if (!current) {
    throw new Error('Missing probe')
  }
  return current
}
async function mount(scope = 'paired', handle = 'terminal-a') {
  await act(async () => {
    tree = create(createElement(Probe, { scope, handle }))
  })
  await act(async () =>
    hook().reconcileTerminalTabs([], [{ id: 'tab-a', leafId: 'leaf-a', terminal: handle }])
  )
}
async function leave() {
  await act(async () => {
    tree?.unmount()
    tree = null
  })
}
afterEach(async () => {
  await leave()
  current = null
  disk.clear()
  vi.clearAllMocks()
})

it('restores an unsent command after leaving and remounting the workspace', async () => {
  await mount()
  await act(async () => hook().setInput('Review release plan'))
  await leave()
  await mount()
  expect(hook().input).toBe('Review release plan')
})

it('restores to the same surface when a terminal handle has been reminted', async () => {
  await mount()
  await act(async () => hook().setInput('Keep this draft'))
  await leave()
  await mount('paired', 'terminal-new')
  expect(hook().input).toBe('Keep this draft')
})

it('isolates execution hosts and preserves both drafts in the same workspace key', async () => {
  await mount('ssh-one')
  await act(async () => hook().setInput('First host draft'))
  await leave()
  await mount('ssh-two')
  expect(hook().input).toBe('')
  await act(async () => hook().setInput('Second host draft'))
  await leave()
  await mount('ssh-one')
  expect(hook().input).toBe('First host draft')
  await leave()
  await mount('ssh-two')
  expect(hook().input).toBe('Second host draft')
})

it('does not resurrect a sent command after a remount', async () => {
  await mount()
  await act(async () => hook().setInput('echo sent'))
  await act(async () => {
    const send = hook().beginBufferedTerminalDraftSend('terminal-a', hook().input)
    hook().settleBufferedTerminalDraftSend(send)
  })
  await leave()
  await mount()
  expect(hook().input).toBe('')
})

it('keeps a rejected send available after leaving the workspace', async () => {
  await mount()
  await act(async () => hook().setInput('echo retry'))
  await act(async () => {
    const send = hook().beginBufferedTerminalDraftSend('terminal-a', hook().input)
    hook().restoreRejectedDraft(send)
  })
  await leave()
  await mount()
  expect(hook().input).toBe('echo retry')
})

it('does not replace input typed while storage hydration is still pending', async () => {
  disk.set(
    key,
    JSON.stringify({
      drafts: { 'paired:old': 'Stale text' },
      surfaces: { 'paired:leaf:leaf-a': 'old' }
    })
  )
  let resolveRead: ((value: string | null) => void) | undefined
  vi.mocked(AsyncStorage.getItem).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRead = resolve
      })
  )
  act(() => {
    tree = create(createElement(Probe, {}))
  })
  await act(async () => {})
  act(() => {
    hook().reconcileTerminalTabs([], [{ id: 'tab-a', leafId: 'leaf-a', terminal: 'terminal-a' }])
    hook().setInput('New text')
  })
  await act(async () => {
    resolveRead?.(disk.get(key) ?? null)
  })
  expect(hook().input).toBe('New text')
})

it('prunes a closed tab rather than restoring its draft on another terminal', async () => {
  await mount()
  await act(async () => hook().setInput('Closed tab draft'))
  await act(async () =>
    hook().reconcileTerminalTabs([{ id: 'tab-a', leafId: 'leaf-a', terminal: 'terminal-a' }], [])
  )
  await leave()
  await mount()
  expect(hook().input).toBe('')
})
