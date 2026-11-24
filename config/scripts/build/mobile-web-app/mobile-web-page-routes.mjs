// Declare only device-proven page routes: omission serves native on older shells/update screen on current ones, not automatic bundler reachability.
// Required grants gate entire route; declare only after supporting shell ships. Optional grants hide one affordance on otherwise complete page.
// Builder owns declarations and manifest checks MobileWebBundleRouteSchema. Haptics census derives required token from every reachable seam.
// Every route offers the device store; without it (an older shell) the page keeps its data in memory only.
const DEVICE_STORE_GRANT = 'native.store.rows'
// Every route's alerts, prompts and pickers; without it (an older shell) the page draws its own.
const DIALOG_GRANT = 'native.dialog.act'
// Full-screen routes' top bar as the native stack header; without it (an older shell) the page draws its own.
const HEADER_GRANT = 'nativeHeader'

export const MOBILE_WEB_PAGE_ROUTES = [
  // Home needs navigate/storage for session hops and app pins; shared protocol-wall Update action needs externalLink. Wide ownsHostArea permits sidebar.
  // New bot's import copies the message for the old bot; Shared links' Copy link writes and From a link's Paste reads.
  {
    pathname: '/h/[hostId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics'],
    optionalGrants: [
      DEVICE_STORE_GRANT,
      DIALOG_GRANT,
      HEADER_GRANT,
      'native.clipboard.write',
      'native.clipboard.read'
    ],
    canOwnHostArea: true,
    canOwnHostAreaAcrossLayouts: true
  },
  // History needs navigate for session/resume, storage for shared sidebar width, externalLink for layout protocol wall
  // and clipboard writes for a hand-off prompt the new agent did not get.
  {
    pathname: '/h/[hostId]/agent-history/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write'],
    optionalGrants: [DEVICE_STORE_GRANT, DIALOG_GRANT, HEADER_GRANT]
  },
  // Tasks needs navigate/storage plus provider externalLink and comment-review clipboard writes; grants persist from opening route.
  {
    pathname: '/h/[hostId]/tasks',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write'],
    optionalGrants: [DEVICE_STORE_GRANT, DIALOG_GRANT, HEADER_GRANT]
  },
  {
    pathname: '/h/[hostId]/automations',
    grants: ['navigate', 'storage', 'externalLink', 'haptics'],
    optionalGrants: [DEVICE_STORE_GRANT, DIALOG_GRANT, HEADER_GRANT]
  },
  // Accounts needs navigate/storage/externalLink for Back/shared layout wall; haptics census requires seam grant.
  {
    pathname: '/h/[hostId]/accounts',
    grants: ['navigate', 'storage', 'externalLink', 'haptics'],
    optionalGrants: [DEVICE_STORE_GRANT, DIALOG_GRANT, HEADER_GRANT]
  },
  // Create Workspace overlay needs navigate to close/open session; shared form/layout supply other grants.
  {
    pathname: '/h/[hostId]/new-workspace',
    grants: ['navigate', 'storage', 'externalLink', 'haptics'],
    // No header grant: an overlay's shell draws no stack header, so its page keeps its own.
    optionalGrants: [DEVICE_STORE_GRANT, DIALOG_GRANT]
  },
  // Explorer grants cover preview too so push stays in document under opening session’s grants; uncovered target hands off and reopens under its own.
  // externalLink serves layout wall/in-document Markdown preview; clipboard.write serves preview Source Copy. Census checks relation.
  {
    pathname: '/h/[hostId]/files/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write'],
    // Older shells cannot open PDFs; the preview asks for an app update instead.
    // Match preview grants for in-document navigation; older shells render inert HTML links.
    optionalGrants: [
      'externalNavigation',
      'native.pdf.view',
      'native.image.act',
      DEVICE_STORE_GRANT,
      DIALOG_GRANT,
      HEADER_GRANT
    ]
  },
  // Preview itself uses Markdown externalLink and Source Copy clipboard; explorer inherits same grants for in-document hop.
  {
    pathname: '/h/[hostId]/files/preview/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write'],
    optionalGrants: [
      'externalNavigation',
      'native.pdf.view',
      'native.image.act',
      DEVICE_STORE_GRANT,
      DIALOG_GRANT,
      HEADER_GRANT
    ]
  },
  // Hub grants cover Back/review navigation, shared storage, PR link openers and conflict-command Copy.
  // Keep pr/history Redirects native: listing them would leave page session bound to pathname redirect already left; native replaces into hub once.
  {
    pathname: '/h/[hostId]/source-control/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write'],
    optionalGrants: [DEVICE_STORE_GRANT, DIALOG_GRANT, HEADER_GRANT]
  },
  // Review grants cover Back/native-session navigation, shared layout, PR links and copy-notes.
  // Match hub grants so both directions stay in-document under opening session’s capabilities; census detects future mismatch.
  {
    pathname: '/h/[hostId]/review/[worktreeId]',
    grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write'],
    optionalGrants: [DEVICE_STORE_GRANT, DIALOG_GRANT, HEADER_GRANT]
  },
  // A group room: Back and its item hops navigate, Copy writes the clipboard, + picks photos and the mic dictates (all three media and audio verbs, as a chat's).
  // The mic's optional grants match the session's: without native.speech.act the computer transcribes, without native.a11y.announce the page's live region speaks.
  {
    pathname: '/h/[hostId]/group/[groupId]',
    grants: [
      'navigate',
      'storage',
      'externalLink',
      'haptics',
      'native.clipboard.write',
      'native.media.pick',
      'native.media.read',
      'native.media.release',
      'native.audio.start',
      'native.audio.read',
      'native.audio.stop'
    ],
    optionalGrants: [
      'externalNavigation',
      'native.image.act',
      'native.speech.act',
      'native.a11y.announce',
      DEVICE_STORE_GRANT
    ]
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
    // Optional media.name falls back to the file type; terminalKeyRail falls back to the page's row; the image viewer drops its actions without native.image.act; dictation uses the computer without native.speech.act; without native.a11y.announce only the page's live region speaks; without native.link.open a link counts as opened once the shell takes it.
    optionalGrants: [
      'externalNavigation',
      'native.media.name',
      'native.pdf.view',
      'native.image.act',
      'native.speech.act',
      'native.a11y.announce',
      'native.link.open',
      'terminalKeyRail',
      DEVICE_STORE_GRANT,
      DIALOG_GRANT,
      HEADER_GRANT
    ]
  }
]
