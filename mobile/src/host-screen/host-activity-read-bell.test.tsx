import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { HostActivityReadBell } from './host-activity-read-bell'

vi.mock('react-native', () => ({
  Pressable: 'button',
  ActivityIndicator: 'progress',
  StyleSheet: { create: (styles: unknown) => styles }
}))
vi.mock('lucide-react-native', () => ({ Bell: 'bell', CircleHelp: 'help' }))

it('toggles only the read marker and prevents the card navigation event', async () => {
  const reads: boolean[] = []
  let stopped = false
  let tree!: ReturnType<typeof create>
  await act(async () => {
    tree = create(
      createElement(HostActivityReadBell, {
        unread: true,
        disabled: false,
        pending: false,
        onChange: (read: boolean) => {
          reads.push(read)
        }
      })
    )
  })
  await act(async () =>
    tree.root.findByType('button').props.onPress({
      stopPropagation: () => {
        stopped = true
      }
    })
  )
  expect(reads).toEqual([true])
  expect(stopped).toBe(true)
  await act(async () =>
    tree.update(
      createElement(HostActivityReadBell, {
        unread: false,
        disabled: false,
        pending: false,
        onChange: (read: boolean) => {
          reads.push(read)
        }
      })
    )
  )
  await act(async () => tree.root.findByType('button').props.onPress({ stopPropagation: () => {} }))
  expect(reads).toEqual([true, false])
  await act(async () => tree.unmount())
})
