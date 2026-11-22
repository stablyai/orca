import { describe, expect, it, vi } from 'vitest'
import type { AppIcon } from '../../components/icons/app-icon-types'
import { pageHeaderPayload } from './page-header-payload'

const icon = (name: string) =>
  Object.assign(() => null, { displayName: name }) as unknown as AppIcon

describe('pageHeaderPayload', () => {
  it('names menu items by id or label, so a press on a changed menu cannot reach a neighbour', () => {
    const tasks = vi.fn()
    const edit = vi.fn()
    const payload = pageHeaderPayload({
      title: 'Host',
      onBack: () => {},
      actions: [
        {
          id: 'more',
          icon: icon('Ellipsis'),
          label: 'More',
          menu: [
            [{ id: 'tasks', label: 'Tasks', onPress: tasks }],
            [
              { label: 'Edit', onPress: edit, disabled: true },
              { label: 'Edit', onPress: () => {} }
            ]
          ]
        }
      ]
    })
    expect(payload?.header.actions).toEqual([
      {
        kind: 'menu',
        id: 'more',
        label: 'More',
        icon: 'Ellipsis',
        menu: [
          [{ id: 'more/tasks', label: 'Tasks', icon: undefined }],
          [
            { id: 'more/Edit', label: 'Edit', icon: undefined, disabled: true },
            { id: 'more/Edit#2', label: 'Edit', icon: undefined }
          ]
        ]
      }
    ])
    payload?.handlers.get('more/Edit')?.()
    expect(edit).toHaveBeenCalledOnce()
    expect(tasks).not.toHaveBeenCalled()
    expect(payload?.header.back).toBe(true)
  })

  it('leaves a header the shell cannot hold to the drawn bar', () => {
    const button = (id: string) => ({ id, icon: icon('Plus'), label: id, onPress: () => {} })
    expect(
      pageHeaderPayload({ title: 'Too many', actions: ['a', 'b', 'c', 'd', 'e'].map(button) })
    ).toBeNull()
  })
})
