import { z } from 'zod'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../browser-extension-namespace-registry'
import {
  ContextMenuError,
  type ContextMenuUpdateProperties,
  createContextMenuItem,
  removeContextMenuItem,
  updateContextMenuItem
} from '../browser-extension-context-menu-model'
import {
  getBrowserExtensionProfileStateStore,
  type StoredContextMenuItem
} from '../browser-extension-profile-state-store'

const idSchema = z.union([z.string(), z.number().int()])
const menuItemPropertyFields = {
  type: z.enum(['normal', 'checkbox', 'radio', 'separator']),
  title: z.string(),
  checked: z.boolean(),
  contexts: z.array(z.string()),
  visible: z.boolean(),
  enabled: z.boolean(),
  parentId: idSchema,
  documentUrlPatterns: z.array(z.string()),
  targetUrlPatterns: z.array(z.string())
}
const createSchema = z
  .object({ id: idSchema, ...menuItemPropertyFields })
  .partial()
  .required({ id: true })
  .loose()
const updateSchema = z.object(menuItemPropertyFields).partial().loose()

function editMenus(
  caller: BrowserExtensionCaller,
  change: (items: StoredContextMenuItem[]) => StoredContextMenuItem[]
): void {
  try {
    getBrowserExtensionProfileStateStore().update(
      caller.browserProfileId,
      caller.extension.id,
      (state) => ({ ...state, contextMenus: change(state.contextMenus) })
    )
  } catch (error) {
    if (error instanceof ContextMenuError) {
      throw new BrowserExtensionApiError(error.message)
    }
    throw error
  }
}

/** Only Chrome's own properties are stored; `onclick` and unknown keys are dropped. */
function knownProperties(properties: z.infer<typeof updateSchema>): ContextMenuUpdateProperties {
  const { type, title, checked, contexts, visible, enabled, parentId } = properties
  const { documentUrlPatterns, targetUrlPatterns } = properties
  const known = {
    type,
    title,
    checked,
    contexts,
    visible,
    enabled,
    parentId,
    documentUrlPatterns,
    targetUrlPatterns
  }
  return Object.fromEntries(Object.entries(known).filter(([, value]) => value !== undefined))
}

/**
 * Items live in the profile's extension state, so they survive restarts the way Chrome's do:
 * extensions that create menus only in onInstalled still have them on the next launch.
 */
export function registerContextMenusNamespace(): void {
  registerBrowserExtensionNamespace('contextMenus', {
    permission: 'contextMenus',
    methods: {
      create: defineBrowserExtensionMethod(z.tuple([createSchema]), (caller, properties) => {
        editMenus(caller, (items) =>
          createContextMenuItem(items, { ...knownProperties(properties), id: properties.id })
        )
        return properties.id
      }),
      update: defineBrowserExtensionMethod(
        z.tuple([idSchema, updateSchema]),
        (caller, id, properties) => {
          editMenus(caller, (items) =>
            updateContextMenuItem(items, id, knownProperties(properties))
          )
        }
      ),
      remove: defineBrowserExtensionMethod(z.tuple([idSchema]), (caller, id) => {
        editMenus(caller, (items) => removeContextMenuItem(items, id))
      }),
      removeAll: defineBrowserExtensionMethod(z.tuple([]), (caller) => {
        editMenus(caller, () => [])
      })
    },
    events: ['onClicked']
  })
}
