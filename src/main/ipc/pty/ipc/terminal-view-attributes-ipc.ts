import { getPtyIpc } from '../../pty-host-bindings'
import {
  getRepoTerminalViewerColorsByHost,
  getTerminalViewerColors,
  refreshTerminalViewAttributesSeed,
  seedTerminalViewerColors,
  setRepoTerminalViewAttributes,
  setRepoTerminalViewerColorsListener,
  setTerminalViewAttributes,
  setTerminalViewAttributesSeedSource,
  setTerminalViewerColorsListener
} from '../../../runtime/terminal-view-attribute-store'
import {
  validateRepoTerminalViewAttributes,
  validateTerminalViewAttributes
} from '../../../../shared/terminal-view-attributes'
import {
  resolveTerminalViewAttributes,
  type TerminalViewAttributesRepo
} from '../../../../shared/terminal-view-attributes-composition'
import { resolveRepoTerminalViewAttributesByHost } from '../../../../shared/repo-terminal-view-attributes-by-host'
import { resolveConfiguredTerminalColors } from '../../../../shared/terminal-viewer-colors'
import {
  publishColorQueryReplyColors,
  publishRepoColorQueryReplyColors
} from '../provider/registry'
import type { PtyIpcSession } from '../session'
import type { Store } from '../../../persistence'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'

/** What the seed needs from the store: the persisted projects and a word when settings change. */
export type TerminalViewAttributesSeedStore = {
  getRepos: () => readonly TerminalViewAttributesRepo[]
  onSettingsChanged?: Store['onSettingsChanged']
}

// Why module-level: the IPC layer re-installs on macOS re-activation; one subscription at a time.
let unsubscribeSeedRefresh: (() => void) | null = null

export function installTerminalViewAttributesIpc(
  session: Pick<PtyIpcSession, 'getSettings' | 'options'> & {
    /** Present when this host has a window of its own. */
    mainWindow?: unknown
    store?: TerminalViewAttributesSeedStore
    runtime?: Pick<OrcaRuntimeService, 'onClientEvent'>
  }
): void {
  setTerminalViewerColorsListener(publishColorQueryReplyColors)
  setRepoTerminalViewerColorsListener(publishRepoColorQueryReplyColors)
  const systemPrefersDark = (): boolean => session.options?.systemPrefersDark?.() ?? true
  // Why seed from settings: a headless host may never hear from a viewer, and a desktop pane
  // can query before the first push lands; either way the owner should answer with the saved theme.
  const seedHostColors = (): void => {
    const settings = session.getSettings?.()
    if (settings) {
      seedTerminalViewerColors(resolveConfiguredTerminalColors(settings, systemPrefersDark()))
    }
  }
  // Why pre-load attributes: a themed project's TUI queries OSC 4/10/11/12 once, at start, often
  // before the renderer publishes; the global snapshot closes the same window for unthemed
  // projects. Window hosts only: paired clients paint a headless host's panes with their own theme.
  // Why before the host seed: the first push to an owner then carries both.
  // Why every host: persisted projects include SSH ones, whose relays answer from their own slice.
  setTerminalViewAttributesSeedSource(
    session.mainWindow
      ? () => {
          const settings = session.getSettings?.()
          const repos = session.store?.getRepos?.()
          if (!settings || !repos) {
            return null
          }
          const prefersDark = systemPrefersDark()
          return {
            global: resolveTerminalViewAttributes(settings, prefersDark),
            byHostId: resolveRepoTerminalViewAttributesByHost(settings, repos, prefersDark)
          }
        }
      : null
  )
  seedHostColors()
  unsubscribeSeedRefresh?.()
  const reseed = (): void => {
    seedHostColors()
    refreshTerminalViewAttributesSeed()
  }
  const unsubscribeSettings = session.store?.onSettingsChanged?.(reseed)
  // Why: a 'system' theme flips with the OS before the renderer's first publish supersedes the seed.
  const unsubscribeAppearance = session.options?.onSystemAppearanceChanged?.(reseed)
  // Why the client event: repo edits from window IPC and paired-client RPC both end in it.
  const unsubscribeRepos = session.runtime?.onClientEvent?.((event) => {
    if (event.type === 'reposChanged') {
      refreshTerminalViewAttributesSeed()
    }
  })
  unsubscribeSeedRefresh = () => {
    unsubscribeSettings?.()
    unsubscribeAppearance?.()
    unsubscribeRepos?.()
  }
  const current = getTerminalViewerColors()
  if (current) {
    publishColorQueryReplyColors(current)
  }
  const byHost = getRepoTerminalViewerColorsByHost()
  if (byHost) {
    publishRepoColorQueryReplyColors(byHost)
  }
  const ipcMain = getPtyIpc()
  ipcMain.removeAllListeners('pty:terminalViewAttributes')
  ipcMain.on('pty:terminalViewAttributes', (_event, args: unknown) => {
    // Why validate-or-drop: a malformed palette would give TUIs a wrong color reply.
    const attributes = validateTerminalViewAttributes(args)
    if (attributes) {
      setTerminalViewAttributes(attributes)
    }
  })
  ipcMain.removeAllListeners('pty:repoTerminalViewAttributes')
  ipcMain.on('pty:repoTerminalViewAttributes', (_event, args: unknown) => {
    const payload = validateRepoTerminalViewAttributes(args)
    if (payload) {
      setRepoTerminalViewAttributes(payload)
    }
  })
}
