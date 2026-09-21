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
 *
 * `haptics` is on every entry below, and by measurement rather than by habit: the shared worktree
 * row is in all five closures and calls the seam, so a route without the grant is a page whose taps
 * stop buzzing. mobile-web-app-haptics-seam.test.mjs derives that list from the closures and fails
 * on a route that imports the seam and declares nothing.
 */
export const MOBILE_WEB_PAGE_ROUTES = [
  // The worktree list. `navigate` because every row opens a session screen that is still native.
  // `storage` because its pins and its last-visited repo are the app's, not the document's.
  { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'haptics'] },
  // Agent session history. `navigate` because a resumed session opens the session screen, which is
  // native, and because the list above now reaches this one without leaving the page. `storage`
  // because the host layout above every page route reads the app's own sidebar width.
  {
    pathname: '/h/[hostId]/agent-history/[worktreeId]',
    grants: ['navigate', 'storage', 'haptics']
  },
  // Tasks. `navigate` for the session screens its rows open and for the Back that pops the native
  // stack; `storage` for the shared components it renders; `externalLink` for the provider links
  // in its items, checks and drawers; `native.clipboard.write` for the two copy actions in its
  // comment review. Grants are scoped per route, so naming fewer here serves fewer.
  {
    pathname: '/h/[hostId]/tasks',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  // The file explorer. `navigate` because its Back pops the native stack. `storage` for the shared
  // components the host layout renders above it.
  //
  // `externalLink` is transitive, not its own: a row opens the preview, and because that is a page
  // route and this list covers what it declares, the handoff keeps that push inside this document.
  // Grants are resolved once, from the route the shell opened (`grantsForRoute` on
  // `session.routePathname`), so a preview reached that way runs under *this* route's grants for
  // the life of the session. Covering the preview is therefore what buys the cheap in-document hop,
  // not what makes it correct: a target this list did not cover would be handed to the shell and
  // reopened under its own grants instead. The census beside it reads that relation off this list.
  //
  // Nothing the explorer itself renders opens a URL. The two openers in its own closure are the
  // shared layout's — the protocol wall, and the New Workspace source field the sidebar renders on
  // a wide layout — and every `/h` route reaches both, `/h/[hostId]` included, which declares no
  // `externalLink`. That tablet tap stays dead on all of them: a pre-existing gap this route
  // neither widens nor fixes.
  //
  // The sidebar `HostScreen` the layout renders on a wide layout pushes to `/h/<id>/tasks` from
  // every page route, and no other route declares the `native.clipboard.write` that one asks for.
  // The handoff gives that hop to the shell rather than keeping it here, which is why this list
  // does not grow a grant it has no screen for.
  {
    pathname: '/h/[hostId]/files/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  // The file preview. Same three. `externalLink` is this route's own rather than inherited: a
  // Markdown preview renders links and `MobileMarkdown` opens them through the platform seam, which
  // is a consumer inside the domain rather than the shared wall. The explorer declares the same
  // list only because it can become this route in-page, so the two happen to be equal today and
  // the reasons are not.
  {
    pathname: '/h/[hostId]/files/preview/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  }
]
