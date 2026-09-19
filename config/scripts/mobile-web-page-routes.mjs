/**
 * The screens this desktop asks a phone's shell to render from the app bundle instead of natively.
 *
 * One entry per route proved on the web, and the list is deliberately short: a route that is not
 * here renders the native screen, which is the state every phone is already in. Adding one is a
 * product decision with a device proof behind it, not a consequence of the bundle happening to
 * contain the module.
 *
 * `grants` names what the screen needs the shell to do for it. A shell that implements fewer than
 * an entry names renders the native screen for that route, so writing a grant here before the app
 * that implements it ships costs nothing and breaks nothing.
 *
 * Declared here rather than in src/shared because the builder is the only thing that reads it: the
 * shape it must satisfy is MobileWebBundleRouteSchema, which the manifest write is checked against.
 */
export const MOBILE_WEB_PAGE_ROUTES = [
  // The worktree list. `navigate` because every row opens a session screen that is still native.
  // `storage` because its pins and its last-visited repo are the app's, not the document's.
  { pathname: '/h/[hostId]', grants: ['navigate', 'storage'] }
]
