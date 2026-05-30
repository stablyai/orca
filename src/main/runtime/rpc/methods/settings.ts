import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'
import {
  BROWSER_PERMISSION_ORDER,
  isSupportedBrowserPermission,
  normalizePermissionOrigin
} from '../../../../shared/browser-permissions'
import type {
  BrowserInteractionMode,
  BrowserPermissionNoticePolicy
} from '../../../../shared/types'

const BROWSER_INTERACTION_MODES = ['agent', 'human'] as const
const BROWSER_PERMISSION_NOTICE_POLICIES = ['all', 'important-only', 'silent-auto-deny'] as const

const BrowserInteractionModeValue = requiredString('Missing required --value')
  .refine(
    (value): value is BrowserInteractionMode =>
      BROWSER_INTERACTION_MODES.includes(value as BrowserInteractionMode),
    { message: 'Invalid browserInteractionMode: expected agent or human' }
  )
  .transform((value) => value as BrowserInteractionMode)

const BrowserPermissionNoticePolicyValue = requiredString('Missing required --value')
  .refine(
    (value): value is BrowserPermissionNoticePolicy =>
      BROWSER_PERMISSION_NOTICE_POLICIES.includes(value as BrowserPermissionNoticePolicy),
    {
      message:
        'Invalid browserPermissionNoticePolicy: expected all, important-only, or silent-auto-deny'
    }
  )
  .transform((value) => value as BrowserPermissionNoticePolicy)

const BrowserPermissionOrigin = requiredString('Missing required --origin').transform(
  (value, ctx) => {
    const origin = normalizePermissionOrigin(value)
    if (!origin) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid --origin: expected an http(s) URL'
      })
      return z.NEVER
    }
    return origin
  }
)

const SupportedBrowserPermission = requiredString('Missing required --permission')
  .refine(isSupportedBrowserPermission, {
    message: `Invalid --permission: expected one of ${BROWSER_PERMISSION_ORDER.join(', ')}`
  })
  .transform((value) => value)

const SettingsSet = z.discriminatedUnion('key', [
  z.object({
    key: z.literal('browserInteractionMode'),
    value: BrowserInteractionModeValue
  }),
  z.object({
    key: z.literal('browserPermissionNoticePolicy'),
    value: BrowserPermissionNoticePolicyValue
  })
])

const BrowserPermissionsList = z.object({
  profileId: OptionalString
})

const BrowserPermissionsSet = z.object({
  profileId: OptionalString,
  origin: BrowserPermissionOrigin,
  permission: SupportedBrowserPermission,
  action: z.enum(['allow', 'deny', 'prompt'])
})

const BrowserPermissionsRemove = z.object({
  profileId: OptionalString,
  origin: BrowserPermissionOrigin,
  permission: SupportedBrowserPermission
})

export const SETTINGS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'settings.set',
    params: SettingsSet,
    handler: async (params, { runtime }) => runtime.settingsSet(params.key, params.value)
  }),
  defineMethod({
    name: 'browserPermissions.list',
    params: BrowserPermissionsList,
    handler: async (params, { runtime }) => runtime.browserPermissionsList(params)
  }),
  defineMethod({
    name: 'browserPermissions.set',
    params: BrowserPermissionsSet,
    handler: async (params, { runtime }) => runtime.browserPermissionsSet(params)
  }),
  defineMethod({
    name: 'browserPermissions.remove',
    params: BrowserPermissionsRemove,
    handler: async (params, { runtime }) => runtime.browserPermissionsRemove(params)
  })
]
