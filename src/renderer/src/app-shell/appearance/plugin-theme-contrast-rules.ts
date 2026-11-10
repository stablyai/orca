// Which theme colors must stay readable together; plugin-theme-tokens.ts runs the checks.

export type ContrastRule = {
  surface: string
  text: string
  min: number
  /** What a failure drops, when not both sides: never a shared token this check must not cost. */
  drop?: readonly string[]
  /** A translucent surface is checked as painted over these, topmost first, down to an opaque one. */
  over?: string | readonly string[]
  /** Passes when the text is no harder to read than on `over`, for text that is dim by design. */
  noWorseThanOver?: boolean
  /** Also dropped when the theme omitted the surface, which then follows this token. */
  surfaceSource?: string
}

export const MIN_TEXT_CONTRAST = 4.5
// Why 3:1: status hues only tint file names, so a theme's own git palette keeps working.
const MIN_STATUS_TEXT_CONTRAST = 3
const textPair = (surface: string, text: string): ContrastRule => ({
  surface,
  text,
  min: MIN_TEXT_CONTRAST
})
/** A chat pair; a translucent chat surface is checked as painted over the chat background. */
const chatPair = (
  surface: string,
  text: string,
  drop?: readonly string[],
  under: readonly string[] = []
): ContrastRule => ({
  ...textPair(surface, text),
  over: [...under, '--chat-canvas'],
  ...(drop ? { drop } : {})
})
const GIT_DECORATIONS = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'untracked',
  'copied',
  'ignored'
]

// Why: a theme must not be able to hide text, so every text/surface pair keeps WCAG AA contrast.
const CONTRAST_RULE_DEFINITIONS: readonly ContrastRule[] = [
  textPair('--background', '--foreground'),
  textPair('--background', '--muted-foreground'),
  // Notebook markdown renders directly on the editor surface.
  textPair('--editor-surface', '--foreground'),
  textPair('--editor-surface', '--muted-foreground'),
  textPair('--card', '--card-foreground'),
  textPair('--popover', '--popover-foreground'),
  textPair('--primary', '--primary-foreground'),
  textPair('--secondary', '--secondary-foreground'),
  textPair('--muted', '--muted-foreground'),
  textPair('--accent', '--accent-foreground'),
  textPair('--sidebar', '--sidebar-foreground'),
  textPair('--sidebar-primary', '--sidebar-primary-foreground'),
  textPair('--sidebar-accent', '--sidebar-accent-foreground'),
  textPair('--worktree-sidebar', '--worktree-sidebar-foreground'),
  textPair('--worktree-sidebar-accent', '--worktree-sidebar-accent-foreground'),
  {
    ...textPair('--worktree-sidebar-active', '--worktree-sidebar-foreground'),
    drop: ['--worktree-sidebar-active'],
    over: '--worktree-sidebar'
  },
  { ...textPair('--host-badge', '--host-badge-foreground'), over: '--worktree-sidebar' },
  textPair('--tab-active', '--tab-active-foreground'),
  textPair('--tab-inactive', '--tab-inactive-foreground'),
  // Hovered inactive tabs take the active text color.
  textPair('--tab-inactive', '--tab-active-foreground'),
  chatPair('--chat-user-message', '--chat-foreground-strong', ['--chat-user-message']),
  ...['added', 'removed'].flatMap((side): ContrastRule[] => {
    const tint = (kind: string): ContrastRule => ({
      ...textPair(`--diff-${side}-${kind}`, '--foreground'),
      drop: [`--diff-${side}-${kind}`],
      surfaceSource: `--diff-${side}`,
      over: '--editor-surface'
    })
    // Chat diff rows paint the hue-mixed text on the line tint over the chat, inside a code block.
    return [
      tint('background'),
      tint('emphasis'),
      { ...tint('background'), text: `--chat-diff-${side}`, over: '--chat-canvas' },
      chatPair(
        `--diff-${side}-background`,
        `--chat-diff-${side}`,
        ['--chat-code-block'],
        ['--chat-code-block']
      )
    ]
  }),
  textPair('--chat-canvas', '--chat-bold-foreground'),
  textPair('--chat-canvas', '--chat-muted-foreground'),
  chatPair('--chat-user-message', '--chat-bold-foreground', ['--chat-bold-foreground']),
  // User messages render Markdown too, so inline code also sits on the bubble. File links wrap
  // inline code, so the link color paints on it as well.
  ...[[], ['--chat-user-message']].flatMap((under) => [
    chatPair('--chat-inline-code', '--chat-inline-code-foreground', undefined, under),
    chatPair('--chat-inline-code', '--chat-link', ['--chat-inline-code'], under)
  ]),
  // Code blocks paint code text; tool output and diffs paint the dimmer body text.
  chatPair('--chat-code-block', '--chat-code-foreground', ['--chat-code-block']),
  chatPair('--chat-code-block', '--chat-foreground', ['--chat-code-block']),
  // Muted text also labels code blocks. A theme's code block is blamed first, and never for a
  // derived muted color that is already under 4.5:1 on the chat; then a theme's muted color.
  ...['--chat-code-block', '--chat-muted-foreground'].map((blamed): ContrastRule => ({
    ...chatPair('--chat-code-block', '--chat-muted-foreground', [blamed]),
    noWorseThanOver: true
  })),
  // A translucent selection shows every chat surface it can cover.
  ...[
    [],
    ['--chat-user-message'],
    ['--chat-code-block'],
    ['--chat-inline-code'],
    ['--chat-inline-code', '--chat-user-message']
  ].map((under) => chatPair('--chat-selection', '--chat-selection-foreground', undefined, under)),
  { ...textPair('--editor-surface', '--text-link'), drop: ['--text-link'] },
  chatPair('--chat-user-message', '--chat-link', ['--chat-user-message']),
  ...GIT_DECORATIONS.map((status): ContrastRule => ({
    surface: '--sidebar',
    text: `--git-decoration-${status}`,
    min: MIN_STATUS_TEXT_CONTRAST,
    drop: [`--git-decoration-${status}`]
  }))
]
export const CONTRAST_RULES = CONTRAST_RULE_DEFINITIONS.map((rule) => ({
  ...rule,
  dropped: rule.drop ?? [rule.surface, rule.text]
}))
// Why 2:1, not WCAG's 3:1: Orca's own light ring is 2.6:1; the goal is a ring that never vanishes.
export const RINGS: readonly (readonly [string, string])[] = [
  ['--ring', '--background'],
  ['--sidebar-ring', '--sidebar'],
  ['--worktree-sidebar-ring', '--worktree-sidebar'],
  ['--tab-active-indicator', '--tab-active']
]
export const MIN_RING_CONTRAST = 2
// Why a floor, not opaque: Orca's own dark borders are 7% white; 0 or near-0 alpha hides them.
export const BORDERS = [
  '--border',
  '--input',
  '--sidebar-border',
  '--worktree-sidebar-border',
  '--worktree-sidebar-active-border',
  '--split-divider',
  '--split-divider-hover'
]
export const MIN_BORDER_ALPHA = 0.05
