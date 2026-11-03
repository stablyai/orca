export type HomeSectionId =
  | 'jumpBackIn'
  | 'desktops'
  | 'tasks'
  | 'automations'
  | 'stats'
  | 'accountUsage'

/** Home's sections, top to bottom, before anyone rearranges them. */
export const DEFAULT_HOME_SECTION_ORDER: readonly HomeSectionId[] = [
  'jumpBackIn',
  'desktops',
  'tasks',
  'automations',
  'stats',
  'accountUsage'
]

export type HomeLayout = {
  order: readonly HomeSectionId[]
  hidden: readonly HomeSectionId[]
}

export const DEFAULT_HOME_LAYOUT: HomeLayout = { order: DEFAULT_HOME_SECTION_ORDER, hidden: [] }

/** Desktops holds "Pair a desktop", the way back from an empty Home, so it always shows. */
export function canHideHomeSection(id: HomeSectionId): boolean {
  return id !== 'desktops'
}

function isHomeSectionId(value: unknown): value is HomeSectionId {
  return DEFAULT_HOME_SECTION_ORDER.some((id) => id === value)
}

function knownIds(value: unknown): HomeSectionId[] {
  return Array.isArray(value) ? [...new Set(value.filter(isHomeSectionId))] : []
}

/** Reads a stored layout: unknown ids drop, sections added since slot in at their default place. */
export function normalizeHomeLayout(value: unknown): HomeLayout {
  if (!value || typeof value !== 'object') {
    return DEFAULT_HOME_LAYOUT
  }
  const order = knownIds('order' in value ? value.order : undefined)
  DEFAULT_HOME_SECTION_ORDER.forEach((id, defaultIndex) => {
    if (order.includes(id)) {
      return
    }
    // After the nearest section that precedes it by default, else first.
    const before = DEFAULT_HOME_SECTION_ORDER.slice(0, defaultIndex).filter((previous) =>
      order.includes(previous)
    )
    const anchor = before.at(-1)
    order.splice(anchor === undefined ? 0 : order.indexOf(anchor) + 1, 0, id)
  })
  const hidden = knownIds('hidden' in value ? value.hidden : undefined).filter(canHideHomeSection)
  return { order, hidden }
}
