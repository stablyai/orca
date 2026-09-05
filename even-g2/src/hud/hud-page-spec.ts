// Contract module (Unit 0). The one Unit-0 module with real logic: this is the single place
// the two fixed HUD layouts' geometry lives (see spec S5), so every screen's container ids,
// positions, and sizes come from here rather than being re-derived per screen.
import type { HudContainerSpec, HudPageBuild } from '../glasses/glasses-bridge'

export type HudScreenPage =
  | { layout: 'text'; header: string; body: string; footer: string }
  | { layout: 'list'; header: string; items: string[]; footer: string }

const HEADER_MAX_CHARS = 200
const FOOTER_MAX_CHARS = 200
const BODY_MAX_CHARS = 1000
const LIST_MAX_ITEMS = 20
const LIST_ITEM_MAX_CHARS = 64

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value
}

function truncateItems(items: string[]): string[] {
  return items.slice(0, LIST_MAX_ITEMS).map((item) => truncate(item, LIST_ITEM_MAX_CHARS))
}

/** Compile a screen page into validated container specs (ids/geometry fixed as in spec S5). */
export function buildHudPage(page: HudScreenPage): HudPageBuild {
  const header: HudContainerSpec = {
    kind: 'text',
    id: 1,
    name: 'header',
    x: 0,
    y: 0,
    width: 576,
    height: 36,
    content: truncate(page.header, HEADER_MAX_CHARS),
    isEventCapture: 0
  }
  const footer: HudContainerSpec = {
    kind: 'text',
    id: 3,
    name: 'footer',
    x: 0,
    y: 252,
    width: 576,
    height: 36,
    content: truncate(page.footer, FOOTER_MAX_CHARS),
    isEventCapture: 0
  }

  if (page.layout === 'list') {
    const list: HudContainerSpec = {
      kind: 'list',
      id: 2,
      name: 'list',
      x: 0,
      y: 36,
      width: 576,
      height: 216,
      items: truncateItems(page.items),
      isEventCapture: 1,
      showSelectionBorder: true
    }
    return { containers: [header, list, footer] }
  }

  const body: HudContainerSpec = {
    kind: 'text',
    id: 2,
    name: 'body',
    x: 0,
    y: 36,
    width: 576,
    height: 216,
    content: truncate(page.body, BODY_MAX_CHARS),
    isEventCapture: 1
  }
  return { containers: [header, body, footer] }
}
