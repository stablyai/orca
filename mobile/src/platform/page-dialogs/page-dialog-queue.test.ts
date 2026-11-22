import { describe, expect, it } from 'vitest'
import { createPageDialogQueue } from './page-dialog-queue'

function confirm(token: string) {
  return { action: 'confirm', token, title: 'Delete branch?', destructive: true }
}

describe('the dialogs a page asks the shell to show', () => {
  it('shows one at a time and refuses a second while the first is up', async () => {
    const queue = createPageDialogQueue({ isFocused: () => true })
    const first = queue.serve(confirm('a'))
    await expect(queue.serve(confirm('b'))).rejects.toThrow()
    expect(queue.current()?.token).toBe('a')

    queue.answer('a', 'confirm')
    await expect(first).resolves.toEqual({ outcome: 'confirm', value: null })
    expect(queue.current()).toBeNull()
  })

  it('lets only the opener withdraw its dialog, so a late dismiss cannot close the next', async () => {
    const queue = createPageDialogQueue({ isFocused: () => true })
    const shown = queue.serve(confirm('next'))
    await expect(queue.serve({ action: 'dismiss', token: 'closed' })).resolves.toEqual({
      dismissed: false
    })
    queue.answer('closed', 'confirm')
    expect(queue.current()?.token).toBe('next')

    await expect(queue.serve({ action: 'dismiss', token: 'next' })).resolves.toEqual({
      dismissed: true
    })
    await expect(shown).resolves.toEqual({ outcome: 'dismiss', value: null })
  })

  it('answers a pending dialog as dismissed when the page goes away', async () => {
    const queue = createPageDialogQueue({ isFocused: () => true })
    const shown = queue.serve({
      action: 'pick',
      token: 't',
      title: 'Base branch',
      options: [{ value: 'main', label: 'main', disabled: false }],
      selected: 'main',
      searchable: false
    })
    queue.dismissAll()
    await expect(shown).resolves.toEqual({ outcome: 'dismiss', value: null })
    expect(queue.current()).toBeNull()
  })

  it('refuses a dialog for a page that is not on screen', async () => {
    const queue = createPageDialogQueue({ isFocused: () => false })
    await expect(queue.serve(confirm('a'))).rejects.toThrow()
    expect(queue.current()).toBeNull()
  })
})
