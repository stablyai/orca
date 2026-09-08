import { BackHandler } from 'react-native'

type MobileWebBackHandlerCallback = () => boolean | null | undefined

type MobileWebBackHandlerTarget = {
  addEventListener(
    eventName: 'hardwareBackPress',
    handler: MobileWebBackHandlerCallback
  ): { remove(): void }
  removeEventListener?: (
    eventName: 'hardwareBackPress',
    handler: MobileWebBackHandlerCallback
  ) => void
}

type MobileWebNavigationTarget = {
  history: History
  location: Pick<Location, 'href'>
  addEventListener(type: 'popstate', listener: (event: PopStateEvent) => void): void
}

const HISTORY_INDEX_KEY = '__orcaMobileWebBackIndex'
const PROGRAMMATIC_TRAVERSAL_TIMEOUT_MS = 5_000
const MAX_EXPECTED_TRAVERSALS = 32
const installedHistories = new WeakMap<object, () => boolean>()

type ExpectedTraversal = {
  targetIndex: number
  timeout: ReturnType<typeof setTimeout>
}

export function installMobileWebBackNavigationAdapter(
  backHandler: MobileWebBackHandlerTarget = BackHandler,
  target: MobileWebNavigationTarget = window
): boolean {
  const { history } = target
  if (installedHistories.has(history)) {
    return false
  }

  const handlers: MobileWebBackHandlerCallback[] = []
  const originalPushState = history.pushState.bind(history)
  const originalReplaceState = history.replaceState.bind(history)
  const originalGo = history.go.bind(history)
  const originalBack = history.back.bind(history)
  const originalForward = history.forward.bind(history)
  let currentIndex = historyIndex(history.state) ?? 0
  let maximumIndex = currentIndex
  const expectedTraversals: ExpectedTraversal[] = []
  let restoringFromIndex: number | null = null

  originalReplaceState(indexedHistoryState(history.state, currentIndex), '', undefined)

  const markProgrammatic = (targetIndex: number): void => {
    if (expectedTraversals.length === MAX_EXPECTED_TRAVERSALS) {
      clearTimeout(expectedTraversals.shift()?.timeout)
    }
    const expected: ExpectedTraversal = {
      targetIndex,
      timeout: setTimeout(() => {
        const index = expectedTraversals.indexOf(expected)
        if (index !== -1) {
          expectedTraversals.splice(index, 1)
        }
      }, PROGRAMMATIC_TRAVERSAL_TIMEOUT_MS)
    }
    expectedTraversals.push(expected)
  }
  const projectedIndex = (): number => expectedTraversals.at(-1)?.targetIndex ?? currentIndex
  history.pushState = (data, unused, url) => {
    currentIndex += 1
    maximumIndex = currentIndex
    originalPushState(indexedHistoryState(data, currentIndex), unused, url)
  }
  history.replaceState = (data, unused, url) => {
    originalReplaceState(indexedHistoryState(data, currentIndex), unused, url)
  }
  history.go = (delta = 0) => {
    const fromIndex = projectedIndex()
    const targetIndex = Math.max(0, Math.min(maximumIndex, fromIndex + delta))
    if (targetIndex !== fromIndex) {
      markProgrammatic(targetIndex)
    }
    originalGo(delta)
  }
  history.back = () => {
    const fromIndex = projectedIndex()
    if (fromIndex > 0) {
      markProgrammatic(fromIndex - 1)
    }
    originalBack()
  }
  history.forward = () => {
    const fromIndex = projectedIndex()
    if (fromIndex < maximumIndex) {
      markProgrammatic(fromIndex + 1)
    }
    originalForward()
  }

  backHandler.addEventListener = (_eventName, handler) => {
    handlers.push(handler)
    let active = true
    return {
      remove() {
        if (!active) {
          return
        }
        active = false
        removeBackHandler(handlers, handler)
      }
    }
  }
  backHandler.removeEventListener = (_eventName, handler) => {
    removeBackHandler(handlers, handler)
  }

  target.addEventListener('popstate', (event) => {
    const nextIndex = historyIndex(event.state)
    if (nextIndex === null) {
      return
    }
    if (restoringFromIndex !== null) {
      event.stopImmediatePropagation()
      restoringFromIndex = null
      currentIndex = nextIndex
      if (!dispatchBackHandlers(handlers)) {
        history.back()
      }
      return
    }

    const direction = Math.sign(nextIndex - currentIndex)
    const expectedIndex = expectedTraversals.findIndex(
      (expected) => expected.targetIndex === nextIndex
    )
    if (expectedIndex !== -1) {
      const consumed = expectedTraversals.splice(0, expectedIndex + 1)
      consumed.forEach((expected) => clearTimeout(expected.timeout))
      currentIndex = nextIndex
      return
    }
    if (direction >= 0 || handlers.length === 0) {
      currentIndex = nextIndex
      return
    }

    event.stopImmediatePropagation()
    restoringFromIndex = nextIndex
    originalGo(currentIndex - nextIndex)
  })
  installedHistories.set(history, () => {
    if (dispatchBackHandlers(handlers)) {
      return true
    }
    if (currentIndex === 0) {
      return false
    }
    history.back()
    return true
  })
  return true
}

export function dispatchMobileWebBackNavigation(
  target: MobileWebNavigationTarget = window
): boolean {
  return installedHistories.get(target.history)?.() === true
}

function dispatchBackHandlers(handlers: MobileWebBackHandlerCallback[]): boolean {
  for (let index = handlers.length - 1; index >= 0; index -= 1) {
    const handler = handlers[index]
    if (!handler) {
      continue
    }
    try {
      if (handler() === true) {
        return true
      }
    } catch {
      continue
    }
  }
  return false
}

function removeBackHandler(
  handlers: MobileWebBackHandlerCallback[],
  target: MobileWebBackHandlerCallback
): void {
  const index = handlers.lastIndexOf(target)
  if (index !== -1) {
    handlers.splice(index, 1)
  }
}

function indexedHistoryState(state: unknown, index: number): Record<string, unknown> {
  return isRecord(state) ? { ...state, [HISTORY_INDEX_KEY]: index } : { [HISTORY_INDEX_KEY]: index }
}

function historyIndex(state: unknown): number | null {
  if (!isRecord(state)) {
    return null
  }
  const value = state[HISTORY_INDEX_KEY]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
