import { expect, it, vi } from 'vitest'
import { AgyAccountSelection } from './agy-account-selection'

const vault = (selectedAccountId: string | null) => ({
  selectedAccountId,
  accounts: [
    { id: 'a', email: 'a@example.com' },
    { id: 'b', email: 'b@example.com' }
  ]
})

function agyProcess() {
  const exits: (() => void)[] = []
  return {
    onExit: (listener: () => void) => exits.push(listener),
    exit: () => exits.forEach((exit) => exit())
  }
}

it('tells listeners of a new selection once known, and only the latest stays committed', async () => {
  const selection = new AgyAccountSelection()
  const heard: (() => boolean)[] = []
  selection.onChanged((committed) => heard.push(committed))
  // The first read of the vault is no change.
  selection.note(vault('a'))
  expect(await selection.atLaunch()).toBe('a')
  expect(heard).toHaveLength(0)

  selection.note(vault('b'))
  selection.note(vault('b'))
  expect(heard).toHaveLength(1)
  expect(selection.current()).toBe('b')
  expect(selection.email('b')).toBe('b@example.com')
  selection.note(vault('a'))
  expect(heard.map((committed) => committed())).toEqual([false, true])
})

it('reads the vault before a launch records an account, and knows nothing until then', async () => {
  const selection = new AgyAccountSelection()
  expect(selection.current()).toBeNull()
  selection.readWith(async () => selection.note(vault('a')))
  expect(await selection.atLaunch()).toBe('a')
})

it('puts the selected login back once the last agy on a previous account exits', () => {
  const selection = new AgyAccountSelection()
  const restore = vi.fn()
  selection.onOldLoginsGone(restore)
  selection.note(vault('a'))
  const chat = agyProcess()
  const listing = agyProcess()
  selection.started(chat)
  selection.started(listing)
  selection.note(vault('b'))
  const onNew = agyProcess()
  selection.started(onNew)

  listing.exit()
  expect(restore).not.toHaveBeenCalled()
  chat.exit()
  expect(restore).toHaveBeenCalledTimes(1)
  // A process on the selected account writes nothing over it.
  onNew.exit()
  expect(restore).toHaveBeenCalledTimes(1)
})

it("doesn't move chats to a selection agy's login couldn't be put on until a later launch reaches it or another is selected", () => {
  const selection = new AgyAccountSelection()
  const heard = vi.fn()
  const notMoved = vi.fn()
  selection.onChanged(heard)
  selection.onChatNotMoved(notMoved)
  selection.note(vault('a'))
  selection.note(vault('b'))
  expect(heard).toHaveBeenCalledTimes(1)
  // A chat prepared for `b` starts on `a`: it says so once, and nothing relaunches it for `b`.
  const failed = { key: 'a', target: 'b', failure: 'keychain access' }
  selection.prepared(failed)
  selection.spawned(agyProcess(), { sessionId: 'chat', key: 'a', prepared: failed })
  expect(notMoved).toHaveBeenCalledExactlyOnceWith({
    sessionId: 'chat',
    to: 'b',
    reason: 'keychain access'
  })
  expect(selection.current()).toBe('b')
  expect(selection.target()).toBeNull()
  // A later launch that does reach `b` lets every chat move.
  selection.prepared({ key: 'b', target: 'b' })
  expect(selection.target()).toBe('b')
  expect(heard).toHaveBeenCalledTimes(2)

  selection.prepared(failed)
  selection.note(vault('a'))
  expect(selection.target()).toBe('a')
})

it('puts the selected login back after an agy that started on another account than selected exits', () => {
  const selection = new AgyAccountSelection()
  const restore = vi.fn()
  selection.onOldLoginsGone(restore)
  selection.note(vault('b'))
  const chat = agyProcess()
  selection.started(chat)
  selection.spawned(chat, { sessionId: 'chat', key: 'a' })
  chat.exit()
  expect(restore).toHaveBeenCalledOnce()
})

it('never waits on an agy whose login no saved account names before putting the selected one back', () => {
  const selection = new AgyAccountSelection()
  const restore = vi.fn()
  selection.onOldLoginsGone(restore)
  selection.note(vault('a'))
  const chat = agyProcess()
  const foreign = agyProcess()
  selection.started(chat)
  selection.started(foreign)
  selection.spawned(foreign, { sessionId: 'elsewhere' })
  selection.note(vault('b'))
  chat.exit()
  expect(restore).toHaveBeenCalledOnce()
  foreign.exit()
  expect(restore).toHaveBeenCalledOnce()
})
