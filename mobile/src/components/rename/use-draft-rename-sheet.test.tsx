import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import type { HostMutationPhase } from '../../query/host-mutation'
import { readHostMutationDraft, setHostMutationDraft } from '../../query/host-mutation-drafts'
import { useDraftRenameSheet } from './use-draft-rename-sheet'

const KEY = 'terminal-rename:host-1:t1'
let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  setHostMutationDraft(KEY, null)
})

it('keeps a newer draft when an older unconfirmed rename lands late', async () => {
  let settle: () => void = () => {}
  let sheet: ReturnType<typeof useDraftRenameSheet> | undefined
  function Sheet({ draftKey }: { draftKey: string | null }) {
    sheet = useDraftRenameSheet({
      draftKey,
      currentName: 'old',
      blockedOffline: false,
      hostName: 'Desk',
      failureMessage: (reason) => reason,
      rename: (_name, onPhase: (phase: HostMutationPhase) => void) =>
        new Promise<void>((resolve) => {
          onPhase('unconfirmed')
          settle = resolve
        })
    })
    return null
  }
  act(() => {
    renderer = create(createElement(Sheet, { draftKey: KEY }))
  })
  act(() => sheet?.sheetProps.onChangeText('first'))
  let saving: Promise<void> | undefined
  act(() => {
    saving = sheet?.submit('first')
  })
  // Closed while the first save waits for its answer: its text is kept.
  act(() => renderer?.update(createElement(Sheet, { draftKey: null })))
  expect(readHostMutationDraft(KEY)).toBe('first')

  // Typed again and closed before the first save landed.
  setHostMutationDraft(KEY, 'second')
  await act(async () => {
    settle()
    await saving
  })
  expect(readHostMutationDraft(KEY)).toBe('second')
})
