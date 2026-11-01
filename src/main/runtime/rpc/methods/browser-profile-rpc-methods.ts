import { defineMethod } from '../core'
import { ProfileCreate } from '../../../../shared/rpc-contract/browser-identity-params'
import {
  ProfileDelete,
  ProfileClearGoogleCookies,
  ProfileImportFromBrowser,
  TabProfileClone,
  TabSetProfile,
  TabShow
} from '../../../../shared/rpc-contract/browser-params'

export const BROWSER_PROFILE_METHODS = [
  defineMethod({
    name: 'browser.tabSetProfile',
    permission: 'workspace',
    params: TabSetProfile,
    handler: async (params, { runtime }) => runtime.browserTabSetProfile(params)
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
    handler: async (params, { runtime }) => runtime.browserTabProfileClone(params)
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
    handler: async (params, { runtime }) => runtime.browserProfileDelete(params)
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
    handler: async (_params, { runtime }) => runtime.browserProfileClearDefaultCookies()
  })
]
