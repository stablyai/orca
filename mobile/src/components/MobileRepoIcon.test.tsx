import { Folder } from 'lucide-react-native'
import { createElement } from 'react'
import { Image } from 'react-native'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileRepoIcon } from './MobileRepoIcon'

vi.mock('react-native', () => ({
  Image: 'Image',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
// Each icon renders as an element named after it.
vi.mock(
  'lucide-react-native',
  () => new Proxy({}, { has: () => true, get: (_, name) => String(name) })
)
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function imageIcon(src: string) {
  return createElement(MobileRepoIcon, { repoIcon: { type: 'image', src, label: 'owner/repo' } })
}

describe('MobileRepoIcon', () => {
  it('shows the folder after an image fails, and tries a changed image again', () => {
    act(() => {
      renderer = create(imageIcon('https://github.com/owner.png?size=64'))
    })
    act(() => renderer!.root.findByType(Image).props.onError())
    expect(renderer!.root.findAllByType(Image)).toHaveLength(0)
    expect(renderer!.root.findAllByType(Folder)).toHaveLength(1)

    act(() => renderer!.update(imageIcon('data:image/png;base64,AAAA')))
    expect(renderer!.root.findByType(Image).props.source).toEqual({
      uri: 'data:image/png;base64,AAAA'
    })
  })
})
