import type { Page } from '@stablyai/playwright-test'

type ProbeState = {
  seen: Map<string, number>
  ready: Map<string, number>
  mutations: number[]
  watch: Set<string>
  refresh: () => void
  cancel: (marker: string) => void
  needComposer: Set<string>
}
declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging
  interface Window {
    __4a?: ProbeState
  }
}

/** Changed text nodes only; activation scans nodes once, never full-root textContent. */
export async function installVisibilityProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (window.__4a) {
      return
    }
    let visible: Element | undefined
    let scheduled = false
    const pending = new Map<string, Element>()
    const enabledAt = new WeakMap<Element, number>()
    const state: ProbeState = {
      seen: new Map(),
      ready: new Map(),
      mutations: [],
      watch: new Set(),
      refresh: () => undefined,
      cancel: () => undefined,
      needComposer: new Set()
    }
    window.__4a = state
    const inspect = (node: Node): void => {
      if (!state.watch.size || !visible?.contains(node)) {
        return
      }
      const parent = node instanceof Element ? node : node.parentElement
      if (parent?.closest('[role="textbox"]')) {
        return
      }
      const checkText = (text: Text): void => {
        // Markers are short prefixes/suffixes; bound observation even for a multi-MiB text node.
        const value =
          text.substringData(0, 4096) +
          (text.length > 4096 ? text.substringData(Math.max(4096, text.length - 4096), 4096) : '')
        for (const marker of state.watch) {
          if (!state.seen.has(marker) && value.includes(marker)) {
            pending.set(marker, visible!)
          }
        }
      }
      if (node instanceof Text) {
        checkText(node)
      } else {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
        let text: Node | null
        let visited = 0
        while (visited++ < 256 && (text = walker.nextNode())) {
          if (text instanceof Text && !text.parentElement?.closest('[role="textbox"]')) {
            checkText(text)
          }
        }
      }
    }
    const refresh = (): void => {
      const root = [...document.querySelectorAll('[data-native-chat-root="true"]')].find((entry) =>
        entry.checkVisibility()
      )
      if (root !== visible) {
        visible = root
        if (root) {
          enabledAt.delete(root)
        }
        if (root && state.watch.size) {
          // Activation may reveal an already mounted transcript: inspect only its last eight message rows and queued cards.
          for (const selector of ['[data-native-chat-message-id]', '[data-queued-message-id]']) {
            const rows = root.querySelectorAll(selector)
            for (const row of [...rows].slice(selector.includes('queued') ? -40 : -8)) {
              inspect(row)
            }
          }
        }
      }
      if (!scheduled && state.watch.size) {
        scheduled = true
        requestAnimationFrame(() => {
          scheduled = false
          const now = performance.now()
          const composer = visible?.querySelector('[role="textbox"]')
          const enabled =
            composer instanceof HTMLElement &&
            composer.isContentEditable &&
            composer.getAttribute('aria-disabled') !== 'true' &&
            !composer.hasAttribute('disabled') &&
            visible?.hasAttribute('data-native-chat-working')
          if (visible && enabled && !enabledAt.has(visible)) {
            enabledAt.set(visible, now)
          }
          if (visible && !enabled) {
            enabledAt.delete(visible)
          }
          for (const marker of state.watch) {
            if (pending.get(marker) !== visible || !visible?.checkVisibility()) {
              continue
            }
            if (!state.seen.has(marker)) {
              state.seen.set(marker, now)
            }
            if (enabled || !state.needComposer.has(marker)) {
              if (enabled) {
                state.ready.set(marker, enabledAt.get(visible) ?? now)
              }
              state.watch.delete(marker)
              pending.delete(marker)
              state.needComposer.delete(marker)
            }
          }
        })
      }
    }
    state.cancel = (marker) => {
      state.watch.delete(marker)
      state.needComposer.delete(marker)
      pending.delete(marker)
    }
    state.refresh = () => {
      if (visible) {
        enabledAt.delete(visible)
      }
      visible = undefined
      refresh()
    }
    new MutationObserver((changes) => {
      refresh()
      let transcriptChanged = false
      for (const change of changes) {
        if (visible?.contains(change.target)) {
          const parent =
            change.target instanceof Element ? change.target : change.target.parentElement
          if (!parent?.closest('[role="textbox"]')) {
            transcriptChanged = true
          }
          if (change.type === 'characterData') {
            inspect(change.target)
          }
          for (const node of change.addedNodes) {
            if (node instanceof Element && node.matches('[data-native-chat-root="true"]')) {
              continue
            }
            inspect(node)
          }
        }
      }
      if (transcriptChanged) {
        state.mutations.push(performance.now())
        if (state.mutations.length > 200_000) {
          state.mutations.splice(0, 100_000)
        }
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'class',
        'style',
        'hidden',
        'contenteditable',
        'aria-disabled',
        'disabled',
        'data-native-chat-working'
      ]
    })
  })
}

export async function watchMarkers(
  page: Page,
  markers: string[],
  needComposer = false
): Promise<void> {
  await page.evaluate(
    ({ markers, needComposer }) => {
      const state = window.__4a
      if (!state) {
        throw new Error('4a visibility probe not installed')
      }
      for (const marker of markers) {
        state.cancel(marker)
        state.seen.delete(marker)
        state.ready.delete(marker)
        state.watch.add(marker)
        if (needComposer) {
          state.needComposer.add(marker)
        }
      }
      state.refresh()
    },
    { markers, needComposer }
  )
}

export async function unwatchMarker(page: Page, marker: string): Promise<void> {
  await page.evaluate((marker) => window.__4a?.cancel(marker), marker)
}

export async function composerEnabledAt(
  page: Page,
  marker: string,
  timeout: number
): Promise<number> {
  const handle = await page.waitForFunction(
    (marker) => window.__4a?.ready.get(marker) ?? false,
    marker,
    { timeout, polling: 16 }
  )
  try {
    return Number(await handle.jsonValue())
  } finally {
    await handle.dispose()
  }
}
