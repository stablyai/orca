package expo.modules.orcamobilewebshell

/**
 * Whether a navigation is dropped. Only the document URL of the generation currently served is
 * allowed to load: nothing in the bundle navigates, so anything that tries is either a link the
 * page opened or a URL the page built, and neither is ours to follow.
 *
 * `true` means Chromium never starts the navigation. A serving host of null means no generation is
 * applied, so there is no document to allow yet.
 */
internal fun mobileWebShellDropsNavigation(
  parts: MobileWebShellRequestParts,
  originHost: String?,
  isForMainFrame: Boolean
): Boolean {
  if (!isForMainFrame || originHost == null) return true
  return resolveMobileWebShellRequestPath(parts, originHost) != "/"
}
