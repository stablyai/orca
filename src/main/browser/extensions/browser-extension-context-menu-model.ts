import type { StoredContextMenuItem } from './browser-extension-profile-state-store'

/**
 * chrome.contextMenus item bookkeeping, after Chromium's context_menus.json and
 * MenuManager: ids are unique per extension, removing an item removes its descendants, and each
 * run of adjacent radio items under one parent keeps exactly one checked.
 */

type MenuItemId = string | number
export type ContextMenuCreateProperties = Partial<Omit<StoredContextMenuItem, 'id'>> & {
  id: MenuItemId
}
export type ContextMenuUpdateProperties = Partial<Omit<StoredContextMenuItem, 'id'>> & {
  parentId?: MenuItemId
}

export class ContextMenuError extends Error {}

export function sameId(a: MenuItemId | undefined, b: MenuItemId | undefined): boolean {
  return a !== undefined && b !== undefined && a === b
}

function describeId(id: MenuItemId): string {
  return typeof id === 'string' ? id : String(id)
}

function descendantsOf(items: StoredContextMenuItem[], id: MenuItemId): Set<MenuItemId> {
  const found = new Set<MenuItemId>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const item of items) {
      if (item.parentId !== undefined && found.has(item.parentId) && !found.has(item.id)) {
        found.add(item.id)
        grew = true
      }
    }
  }
  return found
}

/** Checks `selected` and clears the rest of its run of adjacent radios. */
function selectRadio(
  items: StoredContextMenuItem[],
  selected: StoredContextMenuItem
): StoredContextMenuItem[] {
  const siblings = items.filter((item) => (item.parentId ?? null) === (selected.parentId ?? null))
  const position = siblings.findIndex((item) => sameId(item.id, selected.id))
  let start = position
  while (start > 0 && siblings[start - 1].type === 'radio') {
    start--
  }
  let end = position
  while (end < siblings.length - 1 && siblings[end + 1].type === 'radio') {
    end++
  }
  const run = new Set(siblings.slice(start, end + 1).map((item) => item.id))
  return items.map((item) =>
    run.has(item.id) ? { ...item, checked: sameId(item.id, selected.id) } : item
  )
}

/** Chromium: a radio created or updated as checked wins its run; otherwise sanitize. */
function settleRadios(
  items: StoredContextMenuItem[],
  changed: StoredContextMenuItem,
  explicitlyChecked: boolean
): StoredContextMenuItem[] {
  return sanitizeRadioRuns(
    changed.type === 'radio' && explicitlyChecked ? selectRadio(items, changed) : items
  )
}

/** One checked item per run of adjacent radios sharing a parent (Chromium's SanitizeRadioList). */
export function sanitizeRadioRuns(items: StoredContextMenuItem[]): StoredContextMenuItem[] {
  const result = items.map((item) => ({ ...item }))
  const parents = new Set(result.map((item) => item.parentId ?? null))
  for (const parent of parents) {
    const siblings = result.filter((item) => (item.parentId ?? null) === parent)
    let run: StoredContextMenuItem[] = []
    const settle = (): void => {
      if (run.length > 0) {
        const firstChecked = run.findIndex((item) => item.checked)
        run.forEach((item, index) => {
          item.checked = index === (firstChecked === -1 ? 0 : firstChecked)
        })
      }
      run = []
    }
    for (const item of siblings) {
      if (item.type === 'radio') {
        run.push(item)
      } else {
        settle()
      }
    }
    settle()
  }
  return result
}

export function createContextMenuItem(
  items: StoredContextMenuItem[],
  properties: ContextMenuCreateProperties
): StoredContextMenuItem[] {
  if (items.some((item) => sameId(item.id, properties.id))) {
    throw new ContextMenuError(`Cannot create item with duplicate id ${describeId(properties.id)}`)
  }
  if (
    properties.parentId !== undefined &&
    !items.some((item) => sameId(item.id, properties.parentId))
  ) {
    throw new ContextMenuError(`Cannot find menu item with id ${describeId(properties.parentId)}`)
  }
  const type = properties.type ?? 'normal'
  if (type !== 'separator' && !properties.title) {
    throw new ContextMenuError('Title missing.')
  }
  const item: StoredContextMenuItem = {
    id: properties.id,
    type,
    contexts: properties.contexts?.length ? properties.contexts : ['page'],
    enabled: properties.enabled ?? true,
    visible: properties.visible ?? true,
    ...(properties.parentId !== undefined ? { parentId: properties.parentId } : {}),
    ...(properties.title !== undefined ? { title: properties.title } : {}),
    ...(properties.checked !== undefined ? { checked: properties.checked } : {}),
    ...(properties.documentUrlPatterns
      ? { documentUrlPatterns: properties.documentUrlPatterns }
      : {}),
    ...(properties.targetUrlPatterns ? { targetUrlPatterns: properties.targetUrlPatterns } : {})
  }
  return settleRadios([...items, item], item, properties.checked === true)
}

export function updateContextMenuItem(
  items: StoredContextMenuItem[],
  id: MenuItemId,
  properties: ContextMenuUpdateProperties
): StoredContextMenuItem[] {
  const index = items.findIndex((item) => sameId(item.id, id))
  if (index === -1) {
    throw new ContextMenuError(`Cannot find menu item with id ${describeId(id)}`)
  }
  if (properties.parentId !== undefined) {
    if (!items.some((item) => sameId(item.id, properties.parentId))) {
      throw new ContextMenuError(`Cannot find menu item with id ${describeId(properties.parentId)}`)
    }
    if (descendantsOf(items, id).has(properties.parentId)) {
      throw new ContextMenuError('Cannot set an item to be a descendant of itself')
    }
  }
  const next = items.map((item) => ({ ...item }))
  const definedChanges = Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== undefined)
  )
  next[index] = { ...next[index], ...definedChanges, id: next[index].id }
  return settleRadios(next, next[index], properties.checked === true)
}

export function removeContextMenuItem(
  items: StoredContextMenuItem[],
  id: MenuItemId
): StoredContextMenuItem[] {
  if (!items.some((item) => sameId(item.id, id))) {
    throw new ContextMenuError(`Cannot find menu item with id ${describeId(id)}`)
  }
  const removed = descendantsOf(items, id)
  return sanitizeRadioRuns(items.filter((item) => !removed.has(item.id)))
}

export function findContextMenuItemByKey(
  items: StoredContextMenuItem[],
  key: string
): StoredContextMenuItem | null {
  return items.find((item) => JSON.stringify(item.id) === key) ?? null
}

/** Chrome flips a checkbox, or checks a radio and clears its run, before onClicked fires. */
export function applyContextMenuClick(
  items: StoredContextMenuItem[],
  clicked: StoredContextMenuItem
): { items: StoredContextMenuItem[]; wasChecked?: boolean; checked?: boolean } {
  if (clicked.type === 'checkbox') {
    const checked = !clicked.checked
    return {
      items: items.map((item) => (sameId(item.id, clicked.id) ? { ...item, checked } : item)),
      wasChecked: clicked.checked === true,
      checked
    }
  }
  if (clicked.type !== 'radio') {
    return { items }
  }
  return { items: selectRadio(items, clicked), wasChecked: clicked.checked === true, checked: true }
}
