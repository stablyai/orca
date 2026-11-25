import { defineMethod, InvalidArgumentError, type RpcContext } from '../../core'
import { isAgentRpcCaller } from '../../callers/rpc-caller-identity'
import { isBrowserEngineSidecarLaunch } from '../../callers/browser-engine-sidecar-launch'
import { ProfileCreate } from '../../../../../shared/rpc-contract/browser/browser-identity-params'
import {
  ProfileDelete,
  ProfileClearCookies,
  ProfileClearGoogleCookies,
  ProfileImportFromBrowser,
  TabProfileClone,
  TabSetProfile,
  TabShow
} from '../../../../../shared/rpc-contract/browser/browser-params'

/** Clearing a profile's cookies signs the person out everywhere; only their own click in Settings may. */
export function refuseAgentCookieClear(context: Pick<RpcContext, 'caller'>): void {
  // An orcad's browser engine hears only from that orcad, which refused agents before forwarding.
  if (isAgentRpcCaller(context.caller) && !isBrowserEngineSidecarLaunch()) {
    throw new InvalidArgumentError(
      "Agents can't clear a browser profile's cookies. Clear them from Settings › Browser in Orca."
    )
  }
}

export const BROWSER_PROFILE_METHODS = [
  defineMethod({
    name: 'browser.tabSetProfile',
    permission: 'workspace',
    share: 'not-shared',
    params: TabSetProfile,
    handler: async (params, { runtime }) => runtime.browserTabSetProfile(params)
  }),
  defineMethod({
    name: 'browser.tabProfileShow',
    permission: 'workspace',
    share: 'not-shared',
    params: TabShow,
    handler: async (params, { runtime }) => runtime.browserTabProfileShow(params)
  }),
  defineMethod({
    name: 'browser.tabProfileClone',
    permission: 'workspace',
    share: 'not-shared',
    params: TabProfileClone,
    handler: async (params, { runtime }) => runtime.browserTabProfileClone(params)
  }),
  defineMethod({
    name: 'browser.profileList',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: async (_params, { runtime }) => runtime.browserProfileList()
  }),
  defineMethod({
    name: 'browser.profileCreate',
    permission: 'workspace',
    share: 'not-shared',
    params: ProfileCreate,
    handler: async (params, { runtime }) => runtime.browserProfileCreate(params)
  }),
  defineMethod({
    name: 'browser.profileDelete',
    permission: 'workspace',
    share: 'not-shared',
    params: ProfileDelete,
    handler: async (params, { runtime }) => runtime.browserProfileDelete(params)
  }),
  defineMethod({
    name: 'browser.profileDetectBrowsers',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: async (_params, { runtime }) => runtime.browserProfileDetectBrowsers()
  }),
  defineMethod({
    name: 'browser.profileImportFromBrowser',
    permission: 'workspace',
    share: 'not-shared',
    params: ProfileImportFromBrowser,
    handler: async (params, { runtime }) => runtime.browserProfileImportFromBrowser(params)
  }),
  defineMethod({
    name: 'browser.profileClearGoogleCookies',
    permission: 'workspace',
    share: 'not-shared',
    params: ProfileClearGoogleCookies,
    handler: async (params, { runtime }) => runtime.browserProfileClearGoogleCookies(params)
  }),
  defineMethod({
    name: 'browser.profileClearDefaultCookies',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: async (_params, context) => {
      refuseAgentCookieClear(context)
      return context.runtime.browserProfileClearDefaultCookies()
    }
  }),
  defineMethod({
    name: 'browser.profileClearCookies',
    permission: 'workspace',
    share: 'not-shared',
    params: ProfileClearCookies,
    handler: async (params, context) => {
      refuseAgentCookieClear(context)
      return context.runtime.browserProfileClearCookies(params)
    }
  })
]
