// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import type * as ReactNative from 'react-native'
import { View, TextInput } from 'react-native'
import { expect, it, vi } from 'vitest'
import { MobileNativeChatLowerRegion } from '../MobileNativeChatLowerRegion.web'
import {
  MobileNativeChatComposerAllocation,
  useMobileNativeChatComposerAllocation
} from './MobileNativeChatComposerAllocation.web'
import {
  MobileNativeChatComposerSuggestions,
  type ComposerMenuRow
} from './MobileNativeChatComposerMenu'

vi.mock('react-native', () => vi.importActual<typeof ReactNative>('react-native-web'))
vi.mock(
  './MobileNativeChatComposerAllocation',
  () => import('./MobileNativeChatComposerAllocation.web')
)
vi.mock(
  './MobileNativeChatComposerMenuLayer',
  () => import('./MobileNativeChatComposerMenuLayer.web')
)
vi.mock('../../../platform/keyboard-occlusion', () => ({ useKeyboardOcclusion: () => 0 }))
vi.mock('lucide-react-native', () => ({
  FileText: () => null,
  Package: () => null,
  Terminal: () => null
}))

const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

for (const population of [10, 100]) {
  it(`does no suggestion population work when capacity changes with ${population} results`, async () => {
    let capacity = 600
    let visits = 0
    let fieldMaximum: number | undefined
    const rows: ComposerMenuRow[] = Array.from({ length: population }, (_, index) => ({
      kind: 'file',
      id: `file-${index}`,
      get path() {
        visits++
        return `file-${index}.ts`
      }
    }))
    const container = document.createElement('div')
    container.dataset.testid = 'native-chat-view'
    document.body.append(container)
    const root = createRoot(container)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      return new DOMRect(0, this === container ? 0 : 100, 300, this === container ? capacity : 100)
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => capacity)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.dataset.testid === 'native-chat-composer-menu-reservation') {
        return Number.parseFloat(this.style.height) || 0
      }
      if (this.dataset.testid === 'native-chat-composer-group') {
        const reserve = this.querySelector<HTMLElement>(
          '[data-testid="native-chat-composer-menu-reservation"]'
        )
        return 160 + (Number.parseFloat(reserve?.style.height ?? '') || 0)
      }
      return this instanceof HTMLTextAreaElement ? 80 : 100
    })
    function FieldBudget() {
      fieldMaximum = useMobileNativeChatComposerAllocation()?.fieldMaxHeight
      return null
    }
    function Composer({ items }: { items: ComposerMenuRow[] }) {
      const anchor = useRef<View>(null)
      const field = useRef<TextInput>(null)
      return (
        <MobileNativeChatComposerAllocation anchorRef={anchor} fieldRef={field} hasMenu>
          <View ref={anchor} testID="native-chat-composer-group">
            <MobileNativeChatComposerSuggestions
              anchorRef={anchor}
              rows={items}
              onPick={() => {}}
            />
            <TextInput ref={field} multiline defaultValue="@file" />
            <FieldBudget />
          </View>
        </MobileNativeChatComposerAllocation>
      )
    }
    const render = (items: ComposerMenuRow[]) => (
      <MobileNativeChatLowerRegion>
        <Composer items={items} />
      </MobileNativeChatLowerRegion>
    )
    try {
      await act(async () => root.render(render(rows)))
      await act(async () => container.querySelector('textarea')!.focus())
      await act(paint)
      expect(
        container.querySelector('[aria-label="file-0.ts"]'),
        JSON.stringify({
          focus: document.activeElement?.tagName,
          fieldMaximum,
          html: container.innerHTML.slice(-1800)
        })
      ).not.toBeNull()
      const prior = fieldMaximum
      expect(prior).toBeGreaterThan(0)
      visits = 0
      await act(async () => {
        capacity = 420
        window.dispatchEvent(new Event('resize'))
        await paint()
      })
      await act(paint)
      expect(fieldMaximum).toBeLessThan(prior!)
      expect(visits).toBe(0)
      await act(async () =>
        root.render(render([...rows, { kind: 'file', id: 'new', path: 'new-file.ts' }]))
      )
      expect(visits).toBeGreaterThan(0)
      expect(container.querySelector('[aria-label="new-file.ts"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      container.remove()
      vi.restoreAllMocks()
    }
  })
}
