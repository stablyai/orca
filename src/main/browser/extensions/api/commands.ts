import { z } from 'zod'
import { KEYBINDING_DEFINITIONS, keybindingMatchesAction } from '../../../../shared/keybindings'
import { isAgentInjectingInput } from '../../agent-input-injection'
import { browserManager } from '../../browser-manager'
import {
  emitBrowserExtensionEvent,
  getBrowserExtensionProfileIdForSession
} from '../browser-extension-api-host'
import {
  EXECUTE_ACTION_COMMANDS,
  readBrowserExtensionCommands,
  shortcutMatchesInput
} from '../browser-extension-commands'
import { localizeManifestString } from '../browser-extension-manifest'
import {
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace
} from '../browser-extension-namespace-registry'
import {
  describeBrowserExtensionTab,
  resolveBrowserExtensionTab
} from '../browser-extension-tab-model'
import { runBrowserExtensionToolbarAction } from '../browser-extension-toolbar'
import { noteBrowserExtensionUserGesture } from './permissions'

function isOrcaShortcut(input: Electron.Input): boolean {
  const overrides = browserManager.getKeybindingOverrides()
  return KEYBINDING_DEFINITIONS.some((definition) =>
    keybindingMatchesAction(definition.id, input, process.platform, overrides)
  )
}

function findCommand(
  session: Electron.Session,
  input: Electron.Input
): { extension: Electron.Extension; name: string } | null {
  for (const extension of session.extensions.getAllExtensions()) {
    for (const command of readBrowserExtensionCommands(extension.manifest, process.platform)) {
      if (command.binding && shortcutMatchesInput(command.binding, input)) {
        return { extension, name: command.name }
      }
    }
  }
  return null
}

/** Shortcut keys typed into a tab or popout in an extension session; Orca's shortcuts win. */
export function observeBrowserExtensionCommands(contents: Electron.WebContents): void {
  contents.on('before-input-event', (event, input) => {
    if (
      input.type !== 'keyDown' ||
      input.isAutoRepeat ||
      !(input.control || input.meta || input.alt) ||
      isAgentInjectingInput(contents)
    ) {
      return
    }
    const session = contents.session
    const browserProfileId = getBrowserExtensionProfileIdForSession(session)
    const match = browserProfileId ? findCommand(session, input) : null
    if (!browserProfileId || !match || isOrcaShortcut(input)) {
      return
    }
    event.preventDefault()
    const { extension, name } = match
    noteBrowserExtensionUserGesture(session, extension.id)
    const entry = resolveBrowserExtensionTab(contents.id)
    const tab = entry ? describeBrowserExtensionTab(extension, entry) : undefined
    if (EXECUTE_ACTION_COMMANDS.has(name)) {
      runBrowserExtensionToolbarAction(session, extension).catch((error: unknown) => {
        console.warn('[browser-extensions] Could not run the extension action:', error)
      })
      return
    }
    emitBrowserExtensionEvent(
      { session, extensionId: extension.id },
      'commands',
      'onCommand',
      tab ? [name, tab] : [name]
    )
  })
}

export function registerCommandsNamespace(): void {
  registerBrowserExtensionNamespace('commands', {
    methods: {
      getAll: defineBrowserExtensionMethod(z.tuple([]), async (caller) => {
        const manifest = caller.extension.manifest
        return Promise.all(
          readBrowserExtensionCommands(manifest, process.platform).map(async (command) => ({
            name: command.name,
            description: await localizeManifestString(
              caller.extension.path,
              manifest ?? {},
              command.description
            ),
            shortcut: command.shortcut
          }))
        )
      })
    },
    events: ['onCommand']
  })
}
