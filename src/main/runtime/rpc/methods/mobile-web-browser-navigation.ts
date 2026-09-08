import { z } from 'zod'
import { defineMethod } from '../core'
import {
  isMobileWebPageBrowserNavigationUrl,
  mobileWebPageBrowserUrl,
  MOBILE_WEB_PAGE_BROWSER_URL_MAX_LENGTH
} from '../../../../shared/mobile-web/browser-url-privacy'
import {
  mobileWebBrowserTargetFields,
  MOBILE_WEB_BROWSER_APPLIED,
  MobileWebBrowserTarget
} from './mobile-web-browser-target'

export const MOBILE_WEB_BROWSER_NAVIGATION_METHODS = [
  defineMethod({
    name: 'mobileWeb.browser.navigate',
    params: MobileWebBrowserTarget.extend({
      url: z
        .string()
        .min(1)
        .max(MOBILE_WEB_PAGE_BROWSER_URL_MAX_LENGTH)
        .refine(isMobileWebPageBrowserNavigationUrl, 'Unsupported browser URL')
    }),
    handler: async (params, context) => {
      const result = await context.runtime.browserGoto({
        ...mobileWebBrowserTargetFields(params),
        url: params.url
      })
      // The landing URL can carry credentials the page must never see, so it is stripped here.
      return {
        url: mobileWebPageBrowserUrl(result.url)
      }
    }
  }),
  defineMethod({
    name: 'mobileWeb.browser.history',
    params: MobileWebBrowserTarget.extend({ action: z.enum(['back', 'forward', 'reload']) }),
    handler: async (params, context) => {
      // The host result carries the raw tab URL; the page learns the new location from the stream.
      const target = mobileWebBrowserTargetFields(params)
      switch (params.action) {
        case 'back':
          await context.runtime.browserBack(target)
          break
        case 'forward':
          await context.runtime.browserForward(target)
          break
        case 'reload':
          await context.runtime.browserReload(target)
          break
      }
      return MOBILE_WEB_BROWSER_APPLIED
    }
  })
]
