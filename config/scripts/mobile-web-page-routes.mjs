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
 *
 * `optionalGrants` names what a screen is better with and complete without (ruling 37). A shell that
 * implements fewer than an entry's `grants` renders the native screen; a shell that implements fewer
 * than its `optionalGrants` renders the page and the page hides that one affordance. So the two
 * lanes are a product decision about the screen: a capability the screen cannot be shown without
 * goes above, and one an author can point at a complete screen without goes below.
 */
export const MOBILE_WEB_PAGE_ROUTES = [
  // The worktree list. `navigate` because every row opens a session screen that is still native.
  // `storage` because its pins and its last-visited repo are the app's, not the document's.
  // `externalLink` for the one opener the census finds in this closure: `app/h/_layout.tsx` wraps
  // every `/h` route in `HostProtocolGate`, so without the grant the wall's Update Orca tap posts a
  // notify the shell refuses, with nothing on screen to say why.
  { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'externalLink', 'haptics'] },
  // Agent session history. `navigate` because a resumed session opens the session screen, which is
  // native, and because the list above now reaches this one without leaving the page. `storage`
  // because the host layout above every page route reads the app's own sidebar width.
  // `externalLink` for that same layout's wall, which is this route's only opener too.
  {
    pathname: '/h/[hostId]/agent-history/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
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
  // `externalLink` is the layout wall's here, the single opener the census finds in this closure:
  // nothing the explorer itself renders opens a URL. It is also inherited, and that is what makes
  // the hop below cheap: a row opens the preview, and because that is a page route and this list
  // covers what it declares, the handoff keeps that push inside this document.
  // Grants are resolved once, from the route the shell opened (`grantsForRoute` on
  // `session.routePathname`), so a preview reached that way runs under *this* route's grants for
  // the life of the session. Covering the preview is therefore what buys the cheap in-document hop,
  // not what makes it correct: a target this list did not cover would be handed to the shell and
  // reopened under its own grants instead. The census beside it reads that relation off this list.
  //
  // The sidebar `HostScreen` the layout renders on a wide layout pushes to `/h/<id>/tasks` from
  // every page route, and no other route declares the `native.clipboard.write` that one asks for.
  // The handoff gives that hop to the shell rather than keeping it here, which is why this list
  // does not grow a grant it has no screen for.
  {
    pathname: '/h/[hostId]/files/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  // The file preview. Same three. `externalLink` has a consumer inside the domain as well as the
  // shared wall every `/h` route carries: a Markdown preview renders links and `MobileMarkdown`
  // opens them through the platform seam. That second site is what the census finds here and not in
  // the explorer, which declares the same list for the wall and for the hop into this route.
  {
    pathname: '/h/[hostId]/files/preview/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  // The source-control hub. `navigate` because its Back pops the native stack and its changed-file
  // rows push review; `storage` for the shared components the host layout renders above it;
  // `externalLink` for the three link openers in the PR segment — the checks list, the comment
  // markdown and the comment card; `native.clipboard.write` for the conflict section's copy button.
  //
  // `pr` and `history` are not listed and never will be. Both are `Redirect`s into this route, so
  // listing one would put a redirect inside a page whose session stays bound to the pathname it
  // left; left native they replace into this route and its switch opens the page once. The hop
  // census sees them as call sites naming `source-control`, never as targets of their own.
  {
    pathname: '/h/[hostId]/source-control/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  // Diff review. The same five, and the same reasons read off a different screen: `navigate` for
  // `router.back()` and for the replace into the native session screen; `storage` for the layout;
  // `externalLink` for the same PR sidebar, reached here through `MobileDiffReviewScreenView`;
  // `native.clipboard.write` for the send sheet's copy-notes action.
  //
  // Equal to the hub's on purpose rather than by coincidence. The two push into each other, and a
  // target declaring no more than its opener is a hop the handoff keeps inside the document — which
  // is why registering them together is what buys the cheap hop, and why the census beside this
  // list would show it the moment either grew a grant the other lacks.
  {
    pathname: '/h/[hostId]/review/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  // The session screen: terminal and chat. Thirteen grants, every one of them read off a call site
  // in this route's own closure rather than carried from the design, and it is the only route that
  // asks for the media verbs, the audio verbs or the screencast lane.
  //
  // `navigate` for the Back that pops the native stack and for the seven handoff sites its panels
  // push from; `storage` for the nine exact keys this route added to `page-storage-keys.ts` and the
  // two workspace-scoped ones beside them; `externalLink` for the six openers it reaches —
  // a terminal link tap whose open mode is the phone's browser, the Markdown and file readers, and
  // the PR segment it docks; `haptics` for twenty-four trigger sites, which is the most of any
  // route. `native.clipboard.write` has six call sites (the quick-command row, the sheets, the diff
  // note, the Markdown actions, the accessory selection, the PR conflict list) and
  // `native.clipboard.read` three (the accessory selection, the terminal's paste, the attachment
  // probe): this screen is the heaviest clipboard user in the app and the first route to need the
  // read as well as the write.
  //
  // The three media verbs are one seam, `useMediaPicker`, reached from the image attachment and the
  // chat's image upload. They are declared together because `canPickMedia` is
  // `pick && read && release` — a picked image is a handle, then chunks, so a route holding fewer
  // than all three can start a pick it cannot finish.
  //
  // `screencastBinary` is C6's, and this is the route C6 ruling 3 deferred it to: the browser pane
  // is mounted by `MobileSessionActiveContent`, and `use-browser-binary-screencast-grant.web.ts`
  // asks the shell through the grants `init` carried. Without it the pane subscribes without
  // `wantsBinary` against a shell that would have encoded the frames.
  //
  // The three audio verbs are dictation's, and they are this route's alone: C7.10 PR D put the
  // capture seam on the page and `mobile-web-app-session-dictation-capture.test.mjs` derives the
  // list from the closure, which reaches `dictation-capture.web.ts` from the composer. All three or
  // none — a route granted two opens a microphone it has no verb to close, and the device side
  // holds the screen awake for as long as one is open (#22072 moved that lock off the page, which
  // is why the fourth verb this list carried is gone). Ruling 4's degradation is retired with them:
  // the page no longer falls back to the vendored module's denied microphone.
  //
  // `externalNavigation` is the one optional grant in this list, and it is C8.1's. The HTML preview
  // renders an agent's artifact in a sealed frame, and a tap on a link inside it becomes a top-frame
  // navigation only the shell can cancel and open. Without the grant the preview renders the
  // artifact with its links as text: the document paints, the Preview/Source toggle works, and
  // nothing offers a tap that does nothing (ruling 37.2). Required would have taken this whole
  // screen native on every shell built before the cancelled-navigation event, which is the trade the
  // optional lane exists to avoid. `mobile-web-app-external-navigation-grant.test.mjs` derives the
  // route list from the closure that calls the hook.
  {
    pathname: '/h/[hostId]/session/[worktreeId]',
    grants: [
      'navigate',
      'storage',
      'externalLink',
      'haptics',
      'screencastBinary',
      'native.clipboard.write',
      'native.clipboard.read',
      'native.media.pick',
      'native.media.read',
      'native.media.release',
      'native.audio.start',
      'native.audio.read',
      'native.audio.stop'
    ],
    optionalGrants: ['externalNavigation']
  }
]
