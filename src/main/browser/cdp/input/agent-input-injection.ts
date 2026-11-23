import type { WebContents } from 'electron'
import { assertRemoteCliPageAccess } from '../../routing/input-ownership/remote-cli-page-admission'

// Agent keys must bypass Orca shortcuts, grab handlers, and app menus (#20595).
type InjectionTarget = Pick<WebContents, 'id' | 'isDestroyed' | 'setIgnoreMenuShortcuts'>

export type InjectedInputSource = 'local-agent' | 'remote-viewer'

const activeSourceByGuestId = new Map<number, { source: InjectedInputSource }>()
const injectionSources = new WeakMap<InjectionTarget, InjectedInputSource[]>()

/** Scopes the caller source for injected input on a guest, including out-of-band CDP proxy messages. */
export async function runWithInjectedInputSource<T>(
  webContentsId: number,
  source: InjectedInputSource,
  run: () => Promise<T>
): Promise<T> {
  const previous = activeSourceByGuestId.get(webContentsId)
  const entry = { source }
  activeSourceByGuestId.set(webContentsId, entry)
  try {
    return await run()
  } finally {
    if (activeSourceByGuestId.get(webContentsId) === entry) {
      if (previous === undefined) {
        activeSourceByGuestId.delete(webContentsId)
      } else {
        activeSourceByGuestId.set(webContentsId, previous)
      }
    }
  }
}

export function getAgentInputInjectionSource(
  webContents: InjectionTarget
): InjectedInputSource | null {
  return injectionSources.get(webContents)?.at(-1) ?? null
}

export function isAgentInjectingInput(webContents: InjectionTarget): boolean {
  return getAgentInputInjectionSource(webContents) !== null
}

export async function withAgentInputInjection<T>(
  webContents: InjectionTarget,
  run: () => Promise<T>,
  source?: InjectedInputSource
): Promise<T> {
  assertRemoteCliPageAccess(webContents.id)
  const existing = injectionSources.get(webContents)
  const resolvedSource =
    source ??
    existing?.at(-1) ??
    activeSourceByGuestId.get(webContents.id)?.source ??
    'remote-viewer'
  const sources = existing ?? []
  if (sources.length === 0) {
    injectionSources.set(webContents, sources)
    webContents.setIgnoreMenuShortcuts(true)
  }
  sources.push(resolvedSource)
  try {
    return await run()
  } finally {
    sources.pop()
    if (sources.length === 0) {
      injectionSources.delete(webContents)
      if (!webContents.isDestroyed()) {
        webContents.setIgnoreMenuShortcuts(false)
      }
    }
  }
}
