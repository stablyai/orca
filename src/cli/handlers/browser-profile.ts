import type {
  BrowserProfileCreateResult,
  BrowserProfileDeleteResult,
  BrowserProfileListResult,
  BrowserTabProfileCloneResult,
  BrowserTabProfileShowResult,
  BrowserTabSetProfileResult
} from '../../shared/runtime-types'
import type { CommandHandler } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import {
  formatBrowserProfileList,
  formatTabProfileClone,
  formatTabProfileShow,
  printResult
} from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getBrowserCommandTarget } from '../selectors'

function parseScopeFlag(flags: Map<string, string | boolean>): 'isolated' | 'imported' {
  const raw = getOptionalStringFlag(flags, 'scope')
  if (raw === undefined || raw === 'isolated') {
    return 'isolated'
  }
  if (raw === 'imported') {
    return 'imported'
  }
  throw new RuntimeClientError('invalid_argument', '--scope must be "isolated" or "imported"')
}

export const BROWSER_PROFILE_HANDLERS: Record<string, CommandHandler> = {
  'tab profile list': async ({ client, json }) => {
    const result = await client.call<BrowserProfileListResult>('browser.profileList')
    printResult(result, json, formatBrowserProfileList)
  },
  'tab profile create': async ({ flags, client, json }) => {
    const label = getRequiredStringFlag(flags, 'label')
    const scope = parseScopeFlag(flags)
    const result = await client.call<BrowserProfileCreateResult>('browser.profileCreate', {
      label,
      scope
    })
    if (result.result.profile === null) {
      // Why: registry refuses non-isolated/imported scopes; we already validated
      // the scope client-side, so a null here means a server-side rejection we
      // shouldn't silently report as success.
      throw new RuntimeClientError(
        'runtime_error',
        `Failed to create browser profile (label=${label}, scope=${scope})`
      )
    }
    printResult(
      result,
      json,
      (value) =>
        `Created profile ${value.profile?.id ?? 'unknown'} (${value.profile?.label ?? label})`
    )
  },
  'tab profile delete': async ({ flags, client, json }) => {
    const profileId = getRequiredStringFlag(flags, 'profile')
    const result = await client.call<BrowserProfileDeleteResult>('browser.profileDelete', {
      profileId
    })
    printResult(result, json, (value) =>
      value.deleted
        ? `Deleted profile ${value.profileId}`
        : `Profile ${value.profileId} was not deleted`
    )
  },
  'tab profile set': async ({ flags, client, cwd, json }) => {
    const profileId = getRequiredStringFlag(flags, 'profile')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserTabSetProfileResult>('browser.tabSetProfile', {
      ...target,
      profileId
    })
    printResult(
      result,
      json,
      (value) =>
        `Switched ${value.browserPageId} to ${value.profileLabel ?? value.profileId ?? 'default'}`
    )
  },
  'tab profile show': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserTabProfileShowResult>('browser.tabProfileShow', target)
    printResult(result, json, formatTabProfileShow)
  },
  'tab profile use-default': async ({ flags, client, cwd, json }) => {
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserTabSetProfileResult>('browser.tabSetProfile', {
      ...target,
      profileId: 'default'
    })
    printResult(result, json, (value) => `Switched ${value.browserPageId} to Default`)
  },
  'tab profile clone': async ({ flags, client, cwd, json }) => {
    const profileId = getRequiredStringFlag(flags, 'profile')
    const target = await getBrowserCommandTarget(flags, cwd, client)
    const result = await client.call<BrowserTabProfileCloneResult>('browser.tabProfileClone', {
      ...target,
      profileId
    })
    printResult(result, json, formatTabProfileClone)
  }
}
