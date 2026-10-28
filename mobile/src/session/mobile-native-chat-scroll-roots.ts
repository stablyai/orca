import { MobileNativeChatScrollMotion, scrollKeepsPlace } from './mobile-native-chat-scroll-motion'
import { MobileNativeChatScrollAnchoring } from './mobile-native-chat-scroll-anchoring'
import {
  mobileNativeChatScrollRootAttribute as ROOT,
  mobileNativeChatScrollRootOwners as owners,
  mobileNativeChatScrollRootMember as rootMember,
  mobileNativeChatScrollRootShift as shift,
  mobileNativeChatReadingParts,
  mobileNativeChatRootsDeepestFirst,
  type MobileNativeChatRootPosition,
  type MobileNativeChatScrollRootHandle as Root
} from './mobile-native-chat-scroll-root-handle'
export {
  mobileNativeChatScrollRootKey,
  mobileNativeChatScrollFrame,
  mobileNativeChatVisible,
  mobileNativeChatReadingParts
} from './mobile-native-chat-scroll-root-handle'
export type { MobileNativeChatRootPosition } from './mobile-native-chat-scroll-root-handle'

/** A disclosure owns its own segment anywhere in an address, its `key:part` leaves, and all below. */
function disclosureOwns(key: string, address: string): boolean {
  for (let at = address.indexOf(key); at >= 0; at = address.indexOf(key, at + 1)) {
    const next = address[at + key.length]
    if (
      (at === 0 || address[at - 1] === '/') &&
      (next === undefined || next === '/' || next === ':')
    ) {
      return true
    }
  }
  return false
}

// Track mounted handles only; bounded chat memory retains positions across eviction.
export class MobileNativeChatScrollRoots {
  private roots = new Map<string, Root>()
  private observer: ResizeObserver | null = null
  private held = new Set<Root>()

  constructor(
    private readonly memory: Map<string, MobileNativeChatRootPosition>,
    private readonly limit: number
  ) {}

  register(
    id: string,
    node: HTMLElement,
    content: Element,
    owner: string,
    address: string,
    initialFollow: boolean
  ): () => void {
    const was = this.roots.get(id)
    if (was?.node === node && was.content === content && was.owner === owner) {
      return () => this.unregister(was, true)
    }
    if (was) {
      this.unregister(was, true)
    }
    const occupant = owners.get(node)
    if (occupant) {
      this.unregister(occupant, true)
    }
    const motion = new MobileNativeChatScrollMotion(node.scrollTop)
    const root: Root = {
      id,
      address,
      owner,
      node,
      content,
      position: {
        ...(this.memory.get(address) ?? { top: node.scrollTop, followsEnd: initialFollow })
      },
      work: undefined,
      nextWork: undefined,
      fresh: true,
      motion,
      anchoring: new MobileNativeChatScrollAnchoring(
        () => node,
        () => root.position.followsEnd
      ),
      detach: () => {}
    }
    const input = motion.attach(
      node,
      (event) =>
        event instanceof Event && event.target instanceof Node && node.contains(event.target)
    )
    const scrolled = () => {
      const max = node.scrollHeight - node.clientHeight
      const { by } = motion.scrolled(node.scrollTop, max, () => Math.abs(shift(root)) >= 0.5)
      if (by === 'reader') {
        if (root.nextWork !== undefined) {
          root.position.followsEnd = max - node.scrollTop <= 24
        }
        this.remember(root)
      }
      root.anchoring.sync()
    }
    node.addEventListener('scroll', scrolled, { passive: true })
    root.detach = () => {
      input()
      node.removeEventListener('scroll', scrolled)
    }
    owners.set(node, root)
    node.setAttribute(ROOT, '')
    this.roots.set(id, root)
    this.observer?.observe(node)
    this.observer?.observe(content)
    this.hold(root)
    return () => this.unregister(root, true)
  }

  private unregister(root: Root, remember: boolean): void {
    const current = this.roots.get(root.id) === root
    if (current && remember && root.node.isConnected && !this.held.has(root)) {
      this.remember(root)
    }
    root.detach()
    root.motion.release()
    for (const target of [root.node, root.content]) {
      const viewport = owners.get(target)
      const parent = target.parentElement
      const container = parent ? owners.get(parent) : undefined
      if (
        !(viewport && viewport !== root && this.roots.get(viewport.id) === viewport) &&
        !(
          container &&
          container !== root &&
          container.content === target &&
          this.roots.get(container.id) === container
        )
      ) {
        this.observer?.unobserve(target)
      }
    }
    if (owners.get(root.node) === root) {
      owners.delete(root.node)
      root.node.removeAttribute(ROOT)
    }
    if (current) {
      this.roots.delete(root.id)
    }
    if (this.held.delete(root)) {
      root.anchoring.hold(false)
    }
  }

  readonly observeWith = (observer: ResizeObserver | null): void => {
    for (const { node, content } of this.roots.values()) {
      this.observer?.unobserve(node)
      this.observer?.unobserve(content)
      observer?.observe(node)
      observer?.observe(content)
    }
    this.observer = observer
  }

  layout(id: string, address: string, work?: number): void {
    const root = this.roots.get(id)
    if (!root) {
      return
    }
    root.address = address
    root.nextWork = work
    root.motion.laidOut(`${work}:${root.node.scrollHeight}:${root.node.clientHeight}`)
  }

  private remember(root: Root): void {
    const { node, address } = root
    const member =
      mobileNativeChatReadingParts(node).find((part) => !owners.has(part)) ?? rootMember(root)
    root.position = {
      top: node.scrollTop,
      followsEnd: root.position.followsEnd,
      ...(member
        ? {
            member: member.getAttribute('data-testid') ?? undefined,
            offset: member.getBoundingClientRect().top - node.getBoundingClientRect().top
          }
        : {})
    }
    this.memory.delete(address)
    this.memory.set(address, { ...root.position })
    if (this.memory.size > this.limit) {
      const oldest = this.memory.keys().next().value
      if (oldest !== undefined) {
        this.memory.delete(oldest)
      }
    }
  }

  private hold(root: Root): void {
    if (!this.held.has(root)) {
      this.held.add(root)
      root.anchoring.hold(true)
    }
  }

  capture(movedOwners: ReadonlySet<string>, regrouped: boolean): void {
    for (const root of this.roots.values()) {
      if (!root.fresh) {
        this.remember(root)
      }
      if (regrouped || movedOwners.has(root.owner)) {
        this.hold(root)
      }
    }
  }

  /** Called by the parent commit boundary and the one shared observer, deepest viewport first. */
  restoreAll(regrouped = false, release = true): void {
    const roots = mobileNativeChatRootsDeepestFirst(this.roots.values())
    try {
      for (const { root } of roots) {
        const { node, motion } = root
        if (!node.isConnected) {
          continue
        }
        const max = Math.max(0, node.scrollHeight - node.clientHeight)
        const { by } = motion.reconciled(node.scrollTop, max)
        if (by === 'reader') {
          if (root.work !== undefined) {
            root.position.followsEnd = max - node.scrollTop <= 24
          }
          this.remember(root)
        }
        const position = root.position
        const pin = position.followsEnd && (root.fresh || root.work !== root.nextWork)
        const explicit = this.held.has(root)
        const member = rootMember(root, position)
        const target = pin
          ? max
          : member && position?.offset !== undefined
            ? node.scrollTop +
              member.getBoundingClientRect().top -
              node.getBoundingClientRect().top -
              position.offset
            : (position?.top ?? node.scrollTop)
        const ordinary = !position.followsEnd && scrollKeepsPlace(node.scrollTop)
        const clamped = Math.max(0, Math.min(target, max))
        if (
          (pin || explicit || ordinary) &&
          (regrouped || motion.mayCorrect()) &&
          node.scrollTop >= 0 &&
          node.scrollTop <= max + 1 &&
          Math.abs(clamped - node.scrollTop) >= 0.5
        ) {
          node.scrollTop = clamped
          motion.wrote(node.scrollTop)
        }
        root.fresh = false
        root.work = root.nextWork
        this.remember(root)
        root.anchoring.committed()
      }
    } finally {
      if (release) {
        this.releaseHold()
      }
    }
  }

  releaseHold(): void {
    for (const root of this.held) {
      root.anchoring.hold(false)
    }
    this.held.clear()
  }

  frame(key: string): Element | undefined {
    return this.roots.get(key)?.node
  }
  owner(key: string): string | undefined {
    return this.roots.get(key)?.owner
  }

  forget(key: string): void {
    for (const root of this.roots.values()) {
      if (disclosureOwns(key, root.address)) {
        this.unregister(root, false)
      }
    }
    for (const child of this.memory.keys()) {
      if (disclosureOwns(key, child)) {
        this.memory.delete(child)
      }
    }
  }

  dispose(): void {
    for (const root of this.roots.values()) {
      this.unregister(root, false)
    }
    this.observer = null
    this.releaseHold()
  }
}
