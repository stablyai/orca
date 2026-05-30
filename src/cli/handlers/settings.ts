import type {
  BrowserPermissionRuleListResult,
  BrowserPermissionRuleMutationResult,
  RuntimeSettingsResult
} from '../../shared/runtime-types'
import type { BrowserInteractionMode, BrowserPermissionNoticePolicy } from '../../shared/types'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

type BrowserPermissionSettingsKey = 'browserInteractionMode' | 'browserPermissionNoticePolicy'

type RuntimeClientSettingsResult = {
  settings: Partial<
    Record<BrowserPermissionSettingsKey, BrowserInteractionMode | BrowserPermissionNoticePolicy>
  >
}

function getBrowserPermissionSettingsKey(key: string): BrowserPermissionSettingsKey {
  if (key === 'browserInteractionMode' || key === 'browserPermissionNoticePolicy') {
    return key
  }
  throw new RuntimeClientError(
    'invalid_argument',
    'Invalid --key: expected browserInteractionMode or browserPermissionNoticePolicy'
  )
}

function getDefaultBrowserPermissionSetting(
  key: BrowserPermissionSettingsKey
): BrowserInteractionMode | BrowserPermissionNoticePolicy {
  return key === 'browserInteractionMode' ? 'agent' : 'important-only'
}

export const SETTINGS_HANDLERS: Record<string, CommandHandler> = {
  'settings get': async ({ flags, client, json }) => {
    const key = getBrowserPermissionSettingsKey(getRequiredStringFlag(flags, 'key'))
    const settingsResult = await client.call<RuntimeClientSettingsResult>('settings.get')
    const result = {
      ...settingsResult,
      result: {
        key,
        value: settingsResult.result.settings[key] ?? getDefaultBrowserPermissionSetting(key)
      }
    }
    printResult(result, json, (value) => `${value.key}: ${String(value.value)}`)
  },
  'settings set': async ({ flags, client, json }) => {
    const key = getBrowserPermissionSettingsKey(getRequiredStringFlag(flags, 'key'))
    const value = getRequiredStringFlag(flags, 'value')
    const result = await client.call<RuntimeSettingsResult>('settings.set', {
      key,
      value
    })
    printResult(result, json, (payload) => `${payload.key}: ${String(payload.value)}`)
  },
  'browser-permissions list': async ({ flags, client, json }) => {
    const profileId = getOptionalStringFlag(flags, 'profile')
    const result = await client.call<BrowserPermissionRuleListResult>('browserPermissions.list', {
      profileId
    })
    printResult(result, json, (value) => {
      if (value.rules.length === 0) {
        return `mode: ${value.mode}\nnoticePolicy: ${value.noticePolicy}\nrules: <none>`
      }
      return [
        `mode: ${value.mode}`,
        `noticePolicy: ${value.noticePolicy}`,
        ...value.rules.map(
          (rule) => `${rule.profileId}  ${rule.origin}  ${rule.permission}  ${rule.action}`
        )
      ].join('\n')
    })
  },
  'browser-permissions allow': async ({ flags, client, json }) => {
    const origin = getRequiredStringFlag(flags, 'origin')
    const permission = getRequiredStringFlag(flags, 'permission')
    const profileId = getOptionalStringFlag(flags, 'profile')
    const result = await client.call<BrowserPermissionRuleMutationResult>(
      'browserPermissions.set',
      { profileId, origin, permission, action: 'allow' }
    )
    printResult(
      result,
      json,
      (value) => `allow ${value.permission} for ${value.origin} (${value.profileId})`
    )
  },
  'browser-permissions deny': async ({ flags, client, json }) => {
    const origin = getRequiredStringFlag(flags, 'origin')
    const permission = getRequiredStringFlag(flags, 'permission')
    const profileId = getOptionalStringFlag(flags, 'profile')
    const result = await client.call<BrowserPermissionRuleMutationResult>(
      'browserPermissions.set',
      { profileId, origin, permission, action: 'deny' }
    )
    printResult(
      result,
      json,
      (value) => `deny ${value.permission} for ${value.origin} (${value.profileId})`
    )
  },
  'browser-permissions prompt': async ({ flags, client, json }) => {
    const origin = getRequiredStringFlag(flags, 'origin')
    const permission = getRequiredStringFlag(flags, 'permission')
    const profileId = getOptionalStringFlag(flags, 'profile')
    const result = await client.call<BrowserPermissionRuleMutationResult>(
      'browserPermissions.set',
      { profileId, origin, permission, action: 'prompt' }
    )
    printResult(
      result,
      json,
      (value) => `prompt ${value.permission} for ${value.origin} (${value.profileId})`
    )
  },
  'browser-permissions remove': async ({ flags, client, json }) => {
    const origin = getRequiredStringFlag(flags, 'origin')
    const permission = getRequiredStringFlag(flags, 'permission')
    const profileId = getOptionalStringFlag(flags, 'profile')
    const result = await client.call<BrowserPermissionRuleMutationResult>(
      'browserPermissions.remove',
      { profileId, origin, permission }
    )
    printResult(
      result,
      json,
      (value) => `removed ${value.permission} for ${value.origin} (${value.profileId})`
    )
  }
}
