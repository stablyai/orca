import { describe, expect, it } from 'vitest'
import {
  applyContextMenuClick,
  createContextMenuItem,
  removeContextMenuItem,
  updateContextMenuItem
} from './browser-extension-context-menu-model'
import {
  ACTION_MENU_CONTEXTS,
  arrangeExtensionContextMenuGroup,
  buildContextMenuOnClickData,
  contextMenuTargetFromParams,
  visibleContextMenuTree
} from './browser-extension-context-menu-target'
import type { StoredContextMenuItem } from './browser-extension-profile-state-store'

function build(...items: Parameters<typeof createContextMenuItem>[1][]): StoredContextMenuItem[] {
  return items.reduce<StoredContextMenuItem[]>(createContextMenuItem, [])
}

const pageClick = contextMenuTargetFromParams({}, 'https://site.test/', false)

describe('menu item bookkeeping', () => {
  it('rejects duplicate ids, unknown parents and descendant cycles like Chrome', () => {
    const items = build(
      { id: 'root', title: 'Root' },
      { id: 'child', title: 'Child', parentId: 'root' }
    )
    expect(() => createContextMenuItem(items, { id: 'root', title: 'Again' })).toThrow(
      'Cannot create item with duplicate id root'
    )
    expect(() => createContextMenuItem(items, { id: 'x', title: 'X', parentId: 'nope' })).toThrow(
      'Cannot find menu item with id nope'
    )
    expect(() => updateContextMenuItem(items, 'root', { parentId: 'child' })).toThrow(
      'Cannot set an item to be a descendant of itself'
    )
    expect(() => removeContextMenuItem(items, 7)).toThrow('Cannot find menu item with id 7')
  })

  it('removes descendants with their parent and keeps number and string ids apart', () => {
    const items = build(
      { id: 1, title: 'One' },
      { id: '1', title: 'String one' },
      { id: 'leaf', title: 'Leaf', parentId: 1 }
    )
    expect(removeContextMenuItem(items, 1).map((item) => item.id)).toEqual(['1'])
  })

  it('keeps exactly one checked radio per adjacent run', () => {
    const items = build(
      { id: 'a', title: 'A', type: 'radio' },
      { id: 'b', title: 'B', type: 'radio', checked: true },
      { id: 'sep', type: 'separator' },
      { id: 'c', title: 'C', type: 'radio' }
    )
    expect(items.map((item) => [item.id, item.checked])).toEqual([
      ['a', false],
      ['b', true],
      ['sep', undefined],
      ['c', true]
    ])
  })
})

describe('what a right-click shows', () => {
  const items = build(
    { id: 'page', title: 'On page' },
    { id: 'edit', title: 'Fill "%s"', contexts: ['editable', 'selection'] },
    { id: 'img', title: 'Image', contexts: ['image'], targetUrlPatterns: ['https://cdn.test/*'] },
    {
      id: 'docs',
      title: 'Docs only',
      contexts: ['all'],
      documentUrlPatterns: ['https://docs.test/*']
    },
    { id: 'hidden', title: 'Hidden', visible: false },
    { id: 'toolbar', title: 'Toolbar', contexts: ['action'] }
  )

  it('applies contexts, document and target patterns, and visibility', () => {
    expect(visibleContextMenuTree(items, pageClick).map((item) => item.key)).toEqual(['"page"'])
    const editable = contextMenuTargetFromParams(
      { isEditable: true, selectionText: 'hunter2 is the password I use everywhere online today' },
      'https://site.test/',
      false
    )
    expect(visibleContextMenuTree(items, editable)).toEqual([
      expect.objectContaining({
        key: '"edit"',
        title: 'Fill "hunter2 is the password I use everywhere online to…"'
      })
    ])
    const image = (src: string) =>
      contextMenuTargetFromParams({ mediaType: 'image', srcURL: src }, 'https://docs.test/a', false)
    expect(
      visibleContextMenuTree(items, image('https://cdn.test/x.png')).map((i) => i.key)
    ).toEqual(['"img"', '"docs"'])
    expect(
      visibleContextMenuTree(items, image('https://other.test/x.png')).map((i) => i.key)
    ).toEqual(['"docs"'])
  })

  it('matches a frame click against the frame URL and adds the frame context', () => {
    const target = contextMenuTargetFromParams(
      { frameURL: 'https://docs.test/embed' },
      'https://site.test/',
      true
    )
    expect([...target.contexts]).toEqual(['page', 'frame'])
    expect(visibleContextMenuTree(items, target).map((item) => item.key)).toEqual([
      '"page"',
      '"docs"'
    ])
  })

  it('shows action items only for the toolbar menu', () => {
    const toolbar = {
      contexts: new Set<string>(ACTION_MENU_CONTEXTS),
      pageUrl: 'https://site.test/'
    }
    expect(visibleContextMenuTree(items, toolbar).map((item) => item.key)).toEqual(['"toolbar"'])
  })

  it('drops a parent whose children are all filtered out', () => {
    const nested = build(
      { id: 'parent', title: 'Parent', contexts: ['all'] },
      { id: 'kid', title: 'Kid', parentId: 'parent', contexts: ['link'] }
    )
    expect(visibleContextMenuTree(nested, pageClick)).toEqual([])
  })

  it('shows one item inline and several under a submenu named after the extension', () => {
    const one = visibleContextMenuTree(build({ id: 'a', title: 'A' }), pageClick)
    expect(arrangeExtensionContextMenuGroup('ext', 'Vault', one)?.items).toEqual(one)
    const two = visibleContextMenuTree(
      build({ id: 'a', title: 'A' }, { id: 'b', title: 'B' }),
      pageClick
    )
    expect(arrangeExtensionContextMenuGroup('ext', 'Vault', two)?.items).toEqual([
      { key: '', title: 'Vault', type: 'normal', checked: false, enabled: true, children: two }
    ])
    expect(arrangeExtensionContextMenuGroup('ext', 'Vault', [])).toBeNull()
  })
})

describe('clicking an item', () => {
  it('flips a checkbox and moves the radio selection before onClicked', () => {
    const items = build(
      { id: 'box', title: 'Box', type: 'checkbox' },
      { id: 'r1', title: 'R1', type: 'radio' },
      { id: 'r2', title: 'R2', type: 'radio' }
    )
    const box = applyContextMenuClick(items, items[0])
    expect([box.wasChecked, box.checked]).toEqual([false, true])
    const radio = applyContextMenuClick(items, items[2])
    expect(radio.items.map((item) => [item.id, item.checked])).toEqual([
      ['box', undefined],
      ['r1', false],
      ['r2', true]
    ])
  })

  it("builds Chrome's OnClickData", () => {
    const [item] = build({ id: 'fill', title: 'Fill', contexts: ['editable'], parentId: undefined })
    const target = contextMenuTargetFromParams(
      {
        isEditable: true,
        linkURL: 'https://site.test/next',
        srcURL: 'https://cdn.test/a.png',
        frameURL: 'https://frame.test/',
        selectionText: 'me@site.test'
      },
      'https://site.test/login',
      true
    )
    expect(
      buildContextMenuOnClickData({ item, target, frameId: 12, editable: true, mediaType: 'image' })
    ).toEqual({
      menuItemId: 'fill',
      mediaType: 'image',
      linkUrl: 'https://site.test/next',
      srcUrl: 'https://cdn.test/a.png',
      pageUrl: 'https://site.test/login',
      frameUrl: 'https://frame.test/',
      frameId: 12,
      selectionText: 'me@site.test',
      editable: true
    })
  })
})
