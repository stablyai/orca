import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTree, type Node, type ParseError } from 'jsonc-parser'
import { runBrowserExtensionNativePage } from '../api-runtime/browser-extension-native-page'
import { BrowserExtensionApiError } from '../api-runtime/browser-extension-namespace-registry'

export type BrowserExtensionSessionAccess = 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
type AccessState = {
  levels: Map<string, BrowserExtensionSessionAccess>
  pending: Map<string, Promise<void>>
  uncertain: Set<string>
  values: Map<string, Record<string, unknown>>
}
const sessions = new WeakMap<Electron.Session, Promise<AccessState>>()
const ready = new WeakMap<Electron.Session, AccessState>()

/** Native preferences distinguish integer enum values from strings and JSON doubles. */
export function readBrowserExtensionSessionAccess(
  text: string
): Map<string, BrowserExtensionSessionAccess> {
  const source = text.replace(/^\uFEFF/, '')
  const errors: ParseError[] = []
  const tree = parseTree(source, errors, { allowTrailingComma: true, disallowComments: false })
  if (!tree || tree.type !== 'object' || errors.length) {
    throw new Error('Could not read browser extension storage permissions')
  }
  const child = (node: Node | undefined, key: string): Node | undefined =>
    node?.type === 'object'
      ? node.children?.findLast((entry) => entry.children?.[0]?.value === key)?.children?.[1]
      : undefined
  const settings = child(child(tree, 'extensions'), 'settings')
  const levels = new Map<string, BrowserExtensionSessionAccess>()
  if (settings?.type !== 'object') {
    return levels
  }
  for (const property of settings.children ?? []) {
    const id: unknown = property.children?.[0]?.value
    if (typeof id !== 'string') {
      continue
    }
    const value = child(property.children?.[1], 'storage_session_access_level')
    if (
      value?.type === 'number' &&
      source.slice(value.offset, value.offset + value.length) === '2'
    ) {
      levels.set(id, 'TRUSTED_AND_UNTRUSTED_CONTEXTS')
    } else {
      levels.delete(id)
    }
  }
  return levels
}

/** Seed once before any ordinary extension can mutate the native preference in this session. */
export function initializeBrowserExtensionSessionAccess(
  session: Electron.Session
): Promise<AccessState> {
  let initializing = sessions.get(session)
  if (!initializing) {
    initializing = (async () => {
      if (!session.storagePath) {
        throw new Error('Browser extension storage is unavailable')
      }
      let levels: Map<string, BrowserExtensionSessionAccess>
      try {
        levels = readBrowserExtensionSessionAccess(
          await readFile(join(session.storagePath, 'Preferences'), 'utf8')
        )
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
        levels = new Map()
      }
      const state = {
        levels,
        pending: new Map<string, Promise<void>>(),
        uncertain: new Set<string>(),
        values: new Map<string, Record<string, unknown>>()
      }
      ready.set(session, state)
      return state
    })()
    sessions.set(session, initializing)
  }
  return initializing
}

export function browserExtensionUntrustedSessionAccess(
  session: Electron.Session,
  extensionId: string
): boolean {
  const state = ready.get(session)
  return Boolean(
    state &&
    !state.uncertain.has(extensionId) &&
    state.levels.get(extensionId) === 'TRUSTED_AND_UNTRUSTED_CONTEXTS'
  )
}

async function nativeAccess(
  session: Electron.Session,
  extensionId: string,
  level: BrowserExtensionSessionAccess,
  signal: AbortSignal
): Promise<void> {
  const result = await runBrowserExtensionNativePage({
    session,
    extensionId,
    signal,
    timeoutMs: 2500,
    code: `new Promise(resolve => chrome.storage.session.setAccessLevel({accessLevel:${JSON.stringify(level)}}, () => resolve(chrome.runtime.lastError ? {error:chrome.runtime.lastError.message} : {ok:true})))`
  })
  if (result && typeof result === 'object' && 'error' in result) {
    throw new BrowserExtensionApiError(String(result.error))
  }
  if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
    throw new Error(
      result && typeof result === 'object' && 'error' in result
        ? String(result.error)
        : 'Could not update extension storage permissions'
    )
  }
}

export async function runBrowserExtensionSessionTransaction<T>(
  session: Electron.Session,
  extensionId: string,
  run: (state: AccessState) => Promise<T> | T
): Promise<T> {
  const state = await initializeBrowserExtensionSessionAccess(session)
  const running = (state.pending.get(extensionId) ?? Promise.resolve())
    .catch(() => {})
    .then(() => run(state))
  const settled = running.then(
    () => undefined,
    () => undefined
  )
  state.pending.set(extensionId, settled)
  void settled.then(() => {
    if (state.pending.get(extensionId) === settled) {
      state.pending.delete(extensionId)
    }
  })
  return running
}

export async function reconcileBrowserExtensionSessionAccess(
  session: Electron.Session,
  extensionId: string,
  signal: AbortSignal
): Promise<void> {
  await runBrowserExtensionSessionTransaction(session, extensionId, async (state) => {
    signal.throwIfAborted()
    if (state.uncertain.has(extensionId)) {
      await nativeAccess(
        session,
        extensionId,
        state.levels.get(extensionId) ?? 'TRUSTED_CONTEXTS',
        signal
      )
      state.uncertain.delete(extensionId)
    }
  })
}

export async function setBrowserExtensionSessionAccess(
  session: Electron.Session,
  extensionId: string,
  level: BrowserExtensionSessionAccess,
  signal: AbortSignal
): Promise<void> {
  await runBrowserExtensionSessionTransaction(session, extensionId, async (state) => {
    signal.throwIfAborted()
    const committed = state.levels.get(extensionId) ?? 'TRUSTED_CONTEXTS'
    if (state.uncertain.has(extensionId)) {
      await nativeAccess(session, extensionId, committed, signal)
      state.uncertain.delete(extensionId)
    }
    try {
      await nativeAccess(session, extensionId, level, signal)
      state.levels.set(extensionId, level)
      state.uncertain.delete(extensionId)
    } catch (error) {
      if (error instanceof BrowserExtensionApiError) {
        throw error
      }
      state.uncertain.add(extensionId)
      if (!signal.aborted) {
        await nativeAccess(session, extensionId, committed, signal)
        state.uncertain.delete(extensionId)
      }
      throw error
    }
  })
}
