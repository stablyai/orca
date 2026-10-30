// Declare only device-proven page routes: omission serves native on older shells/update screen on current ones, not automatic bundler reachability.
// Required grants gate entire route; declare only after supporting shell ships. Optional grants hide one affordance on otherwise complete page.
// Builder owns declarations and manifest checks MobileWebBundleRouteSchema. Haptics census derives required token from every reachable seam.
export const MOBILE_WEB_PAGE_ROUTES = [
  // Home needs navigate/storage for session hops and app pins; shared protocol-wall Update action needs externalLink. Wide ownsHostArea permits sidebar.
  {
    pathname: '/h/[hostId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics'],
    canOwnHostArea: true,
    canOwnHostAreaAcrossLayouts: true
  },
  // History needs navigate for session/resume, storage for shared sidebar width and externalLink for layout protocol wall.
  {
    pathname: '/h/[hostId]/agent-history/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  // Tasks needs navigate/storage plus provider externalLink and comment-review clipboard writes; grants persist from opening route.
  {
    pathname: '/h/[hostId]/tasks',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  // Accounts needs navigate/storage/externalLink for Back/shared layout wall; haptics census requires seam grant.
  {
    pathname: '/h/[hostId]/accounts',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  // Create Workspace overlay needs navigate to close/open session; shared form/layout supply other grants.
  {
    pathname: '/h/[hostId]/new-workspace',
    grants: ['navigate', 'storage', 'externalLink', 'haptics']
  },
  // Explorer grants cover preview too so push stays in document under opening session’s grants; uncovered target hands off and reopens under its own.
  // externalLink serves layout wall/in-document Markdown preview; clipboard.write serves preview Source Copy. Census checks relation.
  {
    pathname: '/h/[hostId]/files/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write'],
    // Older shells cannot open PDFs; the preview asks for an app update instead.
    optionalGrants: ['native.pdf.view']
  },
  // Preview itself uses Markdown externalLink and Source Copy clipboard; explorer inherits same grants for in-document hop.
  {
    pathname: '/h/[hostId]/files/preview/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write'],
    optionalGrants: ['native.pdf.view']
  },
  // Hub grants cover Back/review navigation, shared storage, PR link openers and conflict-command Copy.
  // Keep pr/history Redirects native: listing them would leave page session bound to pathname redirect already left; native replaces into hub once.
  {
    pathname: '/h/[hostId]/source-control/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  // Review grants cover Back/native-session navigation, shared layout, PR links and copy-notes.
  // Match hub grants so both directions stay in-document under opening session’s capabilities; census detects future mismatch.
  {
    pathname: '/h/[hostId]/review/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
  },
  // Session alone needs media/audio/screencast grants: native clipboard read/write, navigation/storage/external links/haptics come from actual closure callers.
  // Media pick/read/release are all-or-none; partial set can start handle upload it cannot finish. Audio start/read/stop likewise must permit closing mic; device owns wake lock.
  // screencastBinary lets the pane request wantsBinary from shells that encode frames.
  // Keep externalNavigation optional: older shells still render complete artifact with links inert, rather than sending entire session native. Grant/closure censuses pin callers.
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
    // Optional media.name falls back to the file type; terminalKeyRail falls back to the page's row.
    optionalGrants: [
      'externalNavigation',
      'native.media.name',
      'native.pdf.view',
      'terminalKeyRail'
    ]
  }
]
