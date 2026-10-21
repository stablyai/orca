import type { MobileNativeChatPageMotion } from './mobile-native-chat-page-motion'
import type { MobileNativeChatPageAnchoring } from './mobile-native-chat-page-anchoring'

export type MobileNativeChatRootPosition = {
  top: number
  followsEnd: boolean
  member?: string
  offset?: number
}

type Root = {
  id: string
  address: string
  owner: string
  node: HTMLElement
  content: Element
  position: MobileNativeChatRootPosition
  work: number | undefined
  nextWork: number | undefined
  fresh: boolean
  motion: MobileNativeChatPageMotion
  anchoring: MobileNativeChatPageAnchoring
  detach: () => void
}
export type { Root as MobileNativeChatScrollRootHandle }

const owners = new WeakMap<Element, Root>()
const ROOT = 'data-chat-scroll-root'
export const mobileNativeChatScrollRootKey = (node: Element): string | undefined =>
  owners.get(node)?.id

/** The first viewport crossed from the requesting owner, never a deeper descendant's frame. */
export function mobileNativeChatScrollFrame(node: Element, within: Element): Element | undefined {
  let frame: Element | undefined
  for (let at: Element | null = node; at && at !== within; at = at.parentElement) {
    if (owners.has(at)) {
      frame = at
    }
  }
  return frame
}

export function mobileNativeChatVisible(node: Element, root: Element): boolean {
  const box = node.getBoundingClientRect()
  let { top, bottom } = root.getBoundingClientRect()
  for (let at = node.parentElement; at; at = at.parentElement) {
    if (
      at === root ||
      owners.has(at) ||
      /hidden|clip|auto|scroll/.test(getComputedStyle(at).overflowY)
    ) {
      const clip = at.getBoundingClientRect()
      top = Math.max(top, clip.top)
      bottom = Math.min(bottom, clip.bottom)
    }
  }
  return box.bottom > top && box.top < bottom
}

export function mobileNativeChatReadingParts(root: Element): Element[] {
  const parts = Array.from(root.querySelectorAll(`[data-testid^="chat-member:"], [${ROOT}]`))
  return Array.from(
    new Set(parts.map((part) => mobileNativeChatScrollFrame(part, root) ?? part))
  ).filter((part) => mobileNativeChatVisible(part, root))
}

export { owners as mobileNativeChatScrollRootOwners, ROOT as mobileNativeChatScrollRootAttribute }

export function mobileNativeChatScrollRootMember(
  root: Root,
  position = root.position
): Element | undefined {
  return position?.member
    ? Array.from(root.node.querySelectorAll('[data-testid]')).find(
        (part) =>
          part.getAttribute('data-testid') === position.member &&
          !mobileNativeChatScrollFrame(part, root.node)
      )
    : undefined
}

export function mobileNativeChatScrollRootShift(root: Root): number {
  const position = root.position
  const member = mobileNativeChatScrollRootMember(root, position)
  return member && position?.offset !== undefined
    ? member.getBoundingClientRect().top -
        root.node.getBoundingClientRect().top -
        position.offset +
        root.node.scrollTop -
        position.top
    : 0
}

export function mobileNativeChatRootsDeepestFirst(roots: Iterable<Root>) {
  return Array.from(roots)
    .map((root, index) => {
      let depth = 0
      for (let node = root.node.parentElement; node; node = node.parentElement) {
        depth += 1
      }
      return { root, depth, index }
    })
    .sort((a, b) => b.depth - a.depth || a.index - b.index)
}
