// Commands that skip page admission, which waits for the page's main-frame load first.
export const BROWSER_COMMANDS_WITHOUT_PAGE_ADMISSION: ReadonlySet<string> = new Set([
  // Page admission waits for the load; zoom must apply while the page is still loading.
  'browserZoom',
  'browserSiteDisplay',
  'browserSetSiteColorScheme',
  // Page admission waits for the main-frame load, the very load a stop ends.
  'browserStop',
  // Chrome finds while a page loads; the stop must also reach a page that is still loading.
  'browserFindInPage',
  'browserStopFindInPage',
  'browserTabList',
  'browserTabCurrent',
  'browserTabAnnotations',
  'browserTabClose',
  'browserTabCreate',
  'browserOpenUrlOnClient',
  'browserProfileList',
  'browserProfileCreate',
  'browserProfileDelete',
  'browserProfileDetectBrowsers',
  'browserProfileImportFromBrowser',
  'browserProfileClearGoogleCookies',
  'browserProfileClearDefaultCookies'
])
