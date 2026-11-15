// RN 0.88 removed InteractionManager and points at requestIdleCallback; fall back to a macrotask
// where a host (some web engines, test runtimes) lacks idle callbacks, as react-native-web did.
export function runAfterInteractions(task: () => void): { cancel: () => void } {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(task)
    return { cancel: () => cancelIdleCallback(handle) }
  }
  const handle = setTimeout(task, 0)
  return { cancel: () => clearTimeout(handle) }
}
