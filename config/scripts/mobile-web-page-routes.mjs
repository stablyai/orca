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
  { pathname: '/h/[hostId]', grants: ['navigate', 'storage'] },
  // Agent session history. `navigate` because a resumed session opens the session screen, which is
  // native, and because the list above now reaches this one without leaving the page. `storage`
  // because the host layout above every page route reads the app's own sidebar width.
  { pathname: '/h/[hostId]/agent-history/[worktreeId]', grants: ['navigate', 'storage'] },
  // Tasks. `navigate` for the session screens its rows open and for the Back that pops the native
  // stack; `storage` for the shared components it renders; `externalLink` for the provider links
  // in its items, checks and drawers; `native.clipboard.write` for the two copy actions in its
  // comment review. Grants are scoped per route, so naming fewer here serves fewer.
  {
    pathname: '/h/[hostId]/tasks',
    grants: ['navigate', 'storage', 'externalLink', 'native.clipboard.write']
  },
  // The file explorer. `navigate` because its Back pops the native stack, and because a row opens
  // the preview beside it, which is a page route the handoff keeps inside the document. `storage`
  // for the shared components the host layout renders above it. No `externalLink`: the only thing
  // in this closure that opens a URL is the protocol wall in the shared layout, which every page
  // route reaches and which the worktree list is granted nothing for either.
  { pathname: '/h/[hostId]/files/[worktreeId]', grants: ['navigate', 'storage'] },
  // The file preview. Same two, plus `externalLink`: a Markdown preview renders links, and
  // `MobileMarkdown` opens them through the platform seam. That is a consumer inside the domain
  // rather than the shared wall, which is what makes this route's list longer than the explorer's.
  {
    pathname: '/h/[hostId]/files/preview/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink']
  }
]
