// Shared-worker files run back to back in one module cache; undo each file's mocks and process state.
// A file that leaves timers, listeners or globals behind also drops the module cache, as isolation would.
// Plain JS: it rewires Vitest's mocker and the timer globals, which have no public types.
import { promisify } from 'node:util'
import { afterAll, vi } from 'vitest'

const VITEST_INTERNAL = /\/vitest\/dist\/|\/@vitest\/|vitest-virtual-/
// Registries their owners create on first use and look up again on every access.
const LAZY_GLOBAL_REGISTRY = /^(?:Symbol\(orca\.|__zod_global)/
const PROCESS_KEYS = ['platform', 'arch', 'execPath', 'argv', 'exitCode', 'env']

function resetNode(node) {
  node.evaluated = false
  node.promise = undefined
  node.exports = undefined
}

// Same reset Vitest's isolation applies, limited to modules that saw the mocked one.
function resetImportersOf(modules, id) {
  const pending = [...(modules.getModuleById(id)?.importers ?? [])]
  const seen = new Set()
  while (pending.length > 0) {
    const importer = pending.pop()
    if (seen.has(importer) || VITEST_INTERNAL.test(importer)) {
      continue
    }
    seen.add(importer)
    const node = modules.getModuleById(importer)
    if (node) {
      resetNode(node)
      pending.push(...node.importers)
    }
  }
}

function resetAllModules(modules) {
  for (const [id, node] of modules.idToModuleMap) {
    if (!VITEST_INTERNAL.test(id)) {
      resetNode(node)
      node.importers.clear()
    }
  }
}

function trackTimers(state) {
  const real = { setTimeout, setInterval, clearTimeout, clearInterval }
  function trackedSetTimeout(callback, ms, ...args) {
    if (typeof callback !== 'function') {
      return real.setTimeout(callback, ms, ...args)
    }
    const handle = real.setTimeout(
      (...callbackArgs) => {
        state.pendingTimers.delete(handle)
        callback(...callbackArgs)
      },
      ms,
      ...args
    )
    state.pendingTimers.add(handle)
    return handle
  }
  trackedSetTimeout[promisify.custom] = real.setTimeout[promisify.custom]
  globalThis.setTimeout = trackedSetTimeout
  globalThis.setInterval = (...args) => {
    const handle = real.setInterval(...args)
    state.pendingTimers.add(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    state.pendingTimers.delete(handle)
    real.clearTimeout(handle)
  }
  globalThis.clearInterval = (handle) => {
    state.pendingTimers.delete(handle)
    real.clearInterval(handle)
  }
  state.clearTimer = (handle) => {
    real.clearTimeout(handle)
    real.clearInterval(handle)
  }
}

// The mocker lives across files, unlike this module, so it carries the once-per-worker state.
function installOnce(mocker) {
  if (mocker.orcaSharedWorkerState) {
    return mocker.orcaSharedWorkerState
  }
  const mockPath = mocker.mockPath.bind(mocker)
  // Modules cached by an earlier file hold the real binding; re-run them against this file's mock.
  mocker.mockPath = (originalId, id, ...rest) => {
    mockPath(originalId, id, ...rest)
    resetImportersOf(mocker.evaluatedModules, id)
  }
  const reset = mocker.reset.bind(mocker)
  // And re-run them against the real module before the next file imports them.
  mocker.reset = () => {
    for (const registry of mocker.registries.values()) {
      for (const url of registry.keys()) {
        resetImportersOf(mocker.evaluatedModules, registry.get(url).id)
      }
    }
    reset()
  }
  const state = { pendingTimers: new Set(), clearTimer: () => {} }
  trackTimers(state)
  mocker.orcaSharedWorkerState = state
  return state
}

const mocker = globalThis.__vitest_mocker__
const state = mocker ? installOnce(mocker) : undefined
state?.pendingTimers.clear()

const initialGlobals = Object.getOwnPropertyDescriptors(globalThis)
const initialProcess = Object.fromEntries(
  PROCESS_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(process, key)])
)
const initialListeners = new Map(
  process.eventNames().map((event) => [event, new Set(process.listeners(event))])
)
const initialEnv = { ...process.env }
const initialCwd = process.cwd()
const evaluatedBefore = new Set(
  [...(mocker?.evaluatedModules.idToModuleMap ?? [])]
    .filter(([, node]) => node.evaluated)
    .map(([id]) => id)
)

/** Puts process state back and reports what this file had left behind. */
function restoreProcessState() {
  const leaks = { globals: [], process: [] }
  for (const key of Reflect.ownKeys(globalThis)) {
    if (!(key in initialGlobals) && !LAZY_GLOBAL_REGISTRY.test(String(key))) {
      leaks.globals.push(String(key))
      Reflect.deleteProperty(globalThis, key)
    }
  }
  for (const [key, descriptor] of Object.entries(initialGlobals)) {
    const current = Object.getOwnPropertyDescriptor(globalThis, key)
    if (!Object.is(current?.value, descriptor.value) || current?.get !== descriptor.get) {
      leaks.globals.push(key)
      try {
        Object.defineProperty(globalThis, key, descriptor)
      } catch {
        // Non-configurable globals cannot be put back; the module reset below still applies.
      }
    }
  }
  for (const key of PROCESS_KEYS) {
    const descriptor = initialProcess[key]
    if (descriptor) {
      Object.defineProperty(process, key, descriptor)
    } else {
      Reflect.deleteProperty(process, key)
    }
  }
  for (const event of process.eventNames()) {
    const before = initialListeners.get(event)
    for (const listener of process.listeners(event)) {
      if (!before?.has(listener)) {
        leaks.process.push(`${String(event)} listener`)
        process.removeListener(event, listener)
      }
    }
  }
  for (const handle of state?.pendingTimers ?? []) {
    leaks.process.push('timer')
    state.clearTimer(handle)
  }
  state?.pendingTimers.clear()
  for (const key of Object.keys(process.env)) {
    if (!(key in initialEnv)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, initialEnv)
  if (process.cwd() !== initialCwd) {
    process.chdir(initialCwd)
  }
  return leaks
}

afterAll(async () => {
  // Finish background imports while their file's environment and module promises still exist.
  await vi.dynamicImportSettled()
  // Runs Vitest's end-of-file spy restore now: a spy restored by hand would otherwise be re-applied after this hook.
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  const leaks = restoreProcessState()
  if (mocker && leaks.process.length > 0) {
    // Any cached module may own a cleared timer or listener.
    resetAllModules(mocker.evaluatedModules)
  } else if (mocker && leaks.globals.length > 0) {
    // A module this file loaded may have installed the global it now expects.
    for (const [id, node] of mocker.evaluatedModules.idToModuleMap) {
      if (node.evaluated && !evaluatedBefore.has(id) && !VITEST_INTERNAL.test(id)) {
        resetNode(node)
      }
    }
  }
})
