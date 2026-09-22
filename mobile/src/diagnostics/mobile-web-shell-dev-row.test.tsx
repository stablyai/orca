import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The developer toggle is the only writer of the hybrid shell flag, and the route it opens reads
 * that flag back from storage rather than from this screen. So what the switch shows and what the
 * open button permits must both follow the write, not the tap.
 */
type Doubles = {
  stored: boolean
  saves: { next: boolean; settle: () => void; fail: () => void }[]
  pushes: string[]
}

const doubles = vi.hoisted((): Doubles => ({ stored: false, saves: [], pushes: [] }))

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  Switch: 'Switch',
  Text: 'Text',
  View: 'View'
}))
vi.mock('expo-router', () => ({
  useRouter: () => ({
    push: (href: string) => {
      doubles.pushes.push(href)
    }
  })
}))
vi.mock('lucide-react-native', () => ({ LayoutTemplate: 'LayoutTemplate' }))
vi.mock('../transport/host-store', () => ({ loadHosts: async () => [{ id: 'host-1' }] }))
vi.mock('../storage/preferences', () => ({
  loadMobileWebShellEnabled: async () => doubles.stored,
  saveMobileWebShellEnabled: (next: boolean) =>
    new Promise<void>((resolve, reject) => {
      doubles.saves.push({
        next,
        settle: () => {
          doubles.stored = next
          resolve()
        },
        fail: () => reject(new Error('storage unavailable'))
      })
    })
}))
vi.mock('./troubleshoot-screen-styles', () => ({ troubleshootScreenStyles: {} }))

import { MobileWebShellDevRow } from './mobile-web-shell-dev-row'

function only(tree: ReactTestRenderer, testID: string): ReactTestInstance {
  const found = tree.root.findAll((node) => node.props.testID === testID)
  const node = found[0]
  if (node === undefined || found.length !== 1) {
    throw new Error(`expected one ${testID}, found ${found.length}`)
  }
  return node
}

async function mountRow(): Promise<ReactTestRenderer> {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  await act(async () => {
    rendered.tree = create(createElement(MobileWebShellDevRow))
  })
  const tree = rendered.tree
  if (tree === null) {
    throw new Error('the row did not mount')
  }
  return tree
}

async function toggle(tree: ReactTestRenderer, next: boolean): Promise<void> {
  await act(async () => {
    only(tree, 'mobile-web-shell-flag').props.onValueChange(next)
  })
}

describe('the hybrid shell developer row', () => {
  beforeEach(() => {
    doubles.stored = false
    doubles.saves.length = 0
    doubles.pushes.length = 0
  })

  it('offers neither the new position nor the route until the write lands', async () => {
    const tree = await mountRow()
    await toggle(tree, true)

    expect(doubles.saves).toHaveLength(1)
    expect(only(tree, 'mobile-web-shell-flag').props.value).toBe(false)
    expect(only(tree, 'mobile-web-shell-flag').props.disabled).toBe(true)
    expect(only(tree, 'mobile-web-shell-open').props.disabled).toBe(true)

    await act(async () => {
      doubles.saves[0]?.settle()
    })
    expect(only(tree, 'mobile-web-shell-flag').props.value).toBe(true)
    expect(only(tree, 'mobile-web-shell-open').props.disabled).toBe(false)
  })

  it('keeps the open button shut while a write that turns the flag off is still in flight', async () => {
    doubles.stored = true
    const tree = await mountRow()
    expect(only(tree, 'mobile-web-shell-open').props.disabled).toBe(false)

    await toggle(tree, false)
    expect(only(tree, 'mobile-web-shell-open').props.disabled).toBe(true)
  })

  it('leaves the switch where storage still is when the write fails', async () => {
    const tree = await mountRow()
    await toggle(tree, true)
    await act(async () => {
      doubles.saves[0]?.fail()
    })

    expect(only(tree, 'mobile-web-shell-flag').props.value).toBe(false)
    expect(only(tree, 'mobile-web-shell-flag').props.disabled).toBe(false)
    expect(only(tree, 'mobile-web-shell-open').props.disabled).toBe(true)
  })
})
