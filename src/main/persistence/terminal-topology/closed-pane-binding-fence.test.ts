import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  _resetClosedPaneFencesForTests,
  fencedIfLayoutOwner,
  isClosedPaneFenced,
  partitionsFence
} from './closed-pane-binding-fence'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const LOCAL: ExecutionHostId = 'local'
const SSH: ExecutionHostId = 'ssh:box'

function sessionWith(tabId: string, leafIds: string[]): WorkspaceSessionState {
  const [first, second] = leafIds
  return {
    ...getDefaultWorkspaceSession(),
    terminalLayoutsByTabId: first
      ? {
          [tabId]: {
            root: second
              ? {
                  type: 'split',
                  direction: 'vertical',
                  first: { type: 'leaf', leafId: first },
                  second: { type: 'leaf', leafId: second }
                }
              : { type: 'leaf', leafId: first },
            activeLeafId: first,
            expandedLeafId: null
          }
        }
      : {}
  }
}

function partitions(initial: Partial<Record<ExecutionHostId, WorkspaceSessionState>>) {
  const sessions = new Map(Object.entries(initial))
  return {
    get: (hostId: ExecutionHostId) => sessions.get(hostId),
    set: (hostId: ExecutionHostId, session: WorkspaceSessionState) => sessions.set(hostId, session)
  }
}

describe('the closed-pane fence', () => {
  afterEach(() => _resetClosedPaneFencesForTests())

  it('a write elsewhere that only keeps a fenced pane does not lift its fence', () => {
    // An old relay reattach left the tab in both partitions; the SSH copy is taken back.
    const store = partitions({
      [SSH]: sessionWith('t', ['a', 'b']),
      [LOCAL]: sessionWith('t', ['a', 'b'])
    })
    fencedIfLayoutOwner(
      () => partitionsFence([SSH], store.get, true),
      () => (store.set(SSH, sessionWith('t', ['a'])), { value: null })
    )()
    expect(isClosedPaneFenced('t:b')).toBe(true)

    fencedIfLayoutOwner(
      () => partitionsFence([LOCAL], store.get, false),
      () => (store.set(LOCAL, sessionWith('t', ['a', 'b'])), { value: null })
    )()
    expect(isClosedPaneFenced('t:b')).toBe(true)
  })

  it('a rolled-back close lifts the fence it wrote, and a rolled-back create restores the one it lifted', () => {
    const store = partitions({ [LOCAL]: sessionWith('t', ['a', 'b']) })
    const close = fencedIfLayoutOwner(
      () => partitionsFence([LOCAL], store.get, true),
      () => (store.set(LOCAL, sessionWith('t', ['a'])), { value: null, rollback: () => {} })
    )()
    expect(isClosedPaneFenced('t:b')).toBe(true)
    close.rollback?.()
    store.set(LOCAL, sessionWith('t', ['a', 'b']))
    expect(isClosedPaneFenced('t:b')).toBe(false)

    fencedIfLayoutOwner(
      () => partitionsFence([LOCAL], store.get, true),
      () => (store.set(LOCAL, sessionWith('t', ['a'])), { value: null })
    )()
    const create = fencedIfLayoutOwner(
      () => partitionsFence([LOCAL], store.get, false),
      () => (store.set(LOCAL, sessionWith('t', ['a', 'b'])), { value: null, rollback: () => {} })
    )()
    expect(isClosedPaneFenced('t:b')).toBe(false)
    create.rollback?.()
    expect(isClosedPaneFenced('t:b')).toBe(true)
  })

  it('records nothing for an unfenced command', () => {
    const store = partitions({ [LOCAL]: sessionWith('t', ['a', 'b']) })
    fencedIfLayoutOwner(
      () => null,
      () => (store.set(LOCAL, sessionWith('t', ['a'])), { value: null })
    )()
    expect(isClosedPaneFenced('t:b')).toBe(false)
  })
})
