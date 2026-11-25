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
import {
  pinAgentTabProfileChange,
  assertAgentMayDeleteProfile
} from './browser-site-list-agent-gate'

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
    params: TabSetProfile,
    handler: async (params, context) => {
      return context.runtime.browserTabSetProfile(
        await pinAgentTabProfileChange(context, params, params.profileId)
      )
    }
  }),
  defineMethod({
    name: 'browser.tabProfileShow',
    permission: 'workspace',
    params: TabShow,
    handler: async (params, { runtime }) => runtime.browserTabProfileShow(params)
  }),
  defineMethod({
    name: 'browser.tabProfileClone',
    permission: 'workspace',
    params: TabProfileClone,
    handler: async (params, context) => {
      return context.runtime.browserTabProfileClone(
        await pinAgentTabProfileChange(context, params, params.profileId)
      )
    }
  }),
  defineMethod({
    name: 'browser.profileList',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.browserProfileList()
  }),
  defineMethod({
    name: 'browser.profileCreate',
    permission: 'workspace',
    params: ProfileCreate,
    handler: async (params, { runtime }) => runtime.browserProfileCreate(params)
  }),
  defineMethod({
    name: 'browser.profileDelete',
    permission: 'workspace',
    params: ProfileDelete,
    handler: async (params, context) => {
      assertAgentMayDeleteProfile(context, params.profileId)
      return context.runtime.browserProfileDelete(params)
    }
  }),
  defineMethod({
    name: 'browser.profileDetectBrowsers',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.browserProfileDetectBrowsers()
  }),
  defineMethod({
    name: 'browser.profileImportFromBrowser',
    permission: 'workspace',
    params: ProfileImportFromBrowser,
    handler: async (params, { runtime }) => runtime.browserProfileImportFromBrowser(params)
  }),
  defineMethod({
    name: 'browser.profileClearGoogleCookies',
    permission: 'workspace',
    params: ProfileClearGoogleCookies,
    handler: async (params, { runtime }) => runtime.browserProfileClearGoogleCookies(params)
  }),
  defineMethod({
    name: 'browser.profileClearDefaultCookies',
    permission: 'workspace',
    params: null,
    handler: async (_params, context) => {
      refuseAgentCookieClear(context)
      return context.runtime.browserProfileClearDefaultCookies()
    }
  }),
  defineMethod({
    name: 'browser.profileClearCookies',
    permission: 'workspace',
    params: ProfileClearCookies,
    handler: async (params, context) => {
      refuseAgentCookieClear(context)
      return context.runtime.browserProfileClearCookies(params)
    }
  })
]
