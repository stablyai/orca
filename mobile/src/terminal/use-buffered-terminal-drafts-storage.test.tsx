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

it('retains an uncertain command separately from new typing across workspace remounts', async () => {
  await mount()
  await act(async () => hook().setInput('possibly executed'))
  await act(async () => {
    const send = hook().beginBufferedTerminalDraftSend('terminal-a', hook().input)
    hook().retainUnconfirmedSend(send)
  })
  await act(async () => hook().setInput('newer draft'))
  await leave()
  await mount()
  expect(hook().input).toBe('newer draft')
  expect(hook().unconfirmedCommand).toBe('possibly executed')
  await act(async () => hook().editUnconfirmedSend())
  expect(hook().input).toBe('newer draft')
  expect(hook().unconfirmedCommand).toBe('possibly executed')
})

it('keeps uncertain delivery pinned to the saved surface after handle remint and to its execution host', async () => {
  await mount('server-one')
  await act(async () => hook().setInput('maybe ran'))
  await act(async () => {
    const send = hook().beginBufferedTerminalDraftSend('terminal-a', hook().input)
    hook().retainUnconfirmedSend(send)
  })
  await leave()
  await mount('server-two', 'same-other-host')
  expect(hook().unconfirmedCommand).toBeNull()
  await leave()
  await mount('server-one', 'reminted-terminal')
  expect(hook().input).toBe('')
  expect(hook().unconfirmedCommand).toBe('maybe ran')
})

it('conservatively retains a send if its screen unmounts before the acknowledgment arrives', async () => {
  await mount()
  await act(async () => hook().setInput('sent before leaving'))
  await act(async () => {
    hook().beginBufferedTerminalDraftSend('terminal-a', hook().input)
  })
  await leave()
  await mount()
  expect(hook().input).toBe('')
  expect(hook().unconfirmedCommand).toBe('sent before leaving')
  expect(hook().awaitingCommandConfirmation).toBe(false)
})

it('journals a command when send and unmount happen in the same event', async () => {
  await mount()
  await act(async () => hook().setInput('echo maybe ran'))
  act(() => {
    hook().beginBufferedTerminalDraftSend('terminal-a', hook().input)
    tree?.unmount()
    tree = null
  })
  await mount()
  expect(hook().input).toBe('')
  expect(hook().unconfirmedCommand).toBe('echo maybe ran')
})

it('keeps retained reconciliation working after switching execution hosts', async () => {
  await mount('host-one')
  const runtimeReconcile = hook().reconcileTerminalTabs
  await act(async () => tree?.update(createElement(Probe, { scope: 'host-two' })))
  await act(async () =>
    hook().reconcileTerminalTabs([], [{ id: 'tab-a', leafId: 'leaf-a', terminal: 'terminal-a' }])
  )
  await act(async () => {
    hook().setInput('scope two command')
  })
  await act(async () => {
    const send = hook().beginBufferedTerminalDraftSend('terminal-a', hook().input)
    hook().retainUnconfirmedSend(send)
  })
  await act(async () => {
    runtimeReconcile(
      [{ id: 'tab-a', leafId: 'leaf-a', terminal: 'terminal-a' }],
      [{ id: 'tab-a', leafId: 'leaf-a', terminal: 'terminal-new' }]
    )
    tree?.update(createElement(Probe, { scope: 'host-two', handle: 'terminal-new' }))
  })
  expect(hook().unconfirmedCommand).toBe('scope two command')
})

it('waits for recovery hydration before admitting any send over an earlier uncertain command', async () => {
  disk.set(
    key,
    JSON.stringify({
      drafts: {},
      unconfirmed: { 'paired:old': 'earlier uncertain command' },
      surfaces: { 'paired:leaf:leaf-a': 'old' }
    })
  )
  let releaseRead: ((raw: string | null) => void) | undefined
  vi.mocked(AsyncStorage.getItem).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseRead = resolve
      })
  )
  act(() => {
    tree = create(createElement(Probe, {}))
  })
  await act(async () => {})
  act(() => {
    hook().reconcileTerminalTabs([], [{ id: 'tab-a', leafId: 'leaf-a', terminal: 'terminal-a' }])
    hook().setInput('new draft')
  })
  expect(hook().recoveryReady()).toBe(false)
  await act(async () => releaseRead?.(disk.get(key) ?? null))
  expect(hook().recoveryReady()).toBe(true)
  expect(hook().input).toBe('new draft')
  expect(hook().unconfirmedCommand).toBe('earlier uncertain command')
})

it('does not allow dispatch before the journal is durably saved', async () => {
  await mount()
  await act(async () => hook().setInput('journal before send'))
  let releaseWrite: (() => void) | undefined
  vi.mocked(AsyncStorage.setItem).mockImplementationOnce(async (storageKey, raw) => {
    await new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    disk.set(storageKey, raw)
  })
  let prepared = false
  let prepare: Promise<boolean> | undefined
  act(() => {
    hook().beginBufferedTerminalDraftSend('terminal-a', hook().input)
    prepare = hook()
      .prepareSend()
      .then((ready) => {
        prepared = ready
        return ready
      })
  })
  await act(async () => {})
  expect(prepared).toBe(false)
  expect(releaseWrite).toBeDefined()
  await act(async () => {
    releaseWrite?.()
    await prepare
  })
  expect(prepared).toBe(true)
  expect(JSON.parse(disk.get(key) ?? '{}').unconfirmed).toEqual({
    'paired:terminal-a': 'journal before send'
  })
})

it('old screen completion cannot overwrite remounted newer draft', async () => {
  await mount()
  await act(async () => hook().setInput('possibly sent'))
  const old = hook()
  let send: ReturnType<typeof old.beginBufferedTerminalDraftSend> | undefined
  await act(async () => {
    send = old.beginBufferedTerminalDraftSend('terminal-a', old.input)
  })
  await leave()
  await mount()
  await act(async () => hook().setInput('new screen text'))
  await act(async () => {
    if (!send) {
      throw new Error('Expected a pending send')
    }
    old.settleBufferedTerminalDraftSend(send)
  })
  await leave()
  await mount()
  expect(hook().input).toBe('new screen text')
})
