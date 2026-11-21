// Colours that paint content rather than chrome: every platform shares them, so code and diffs read the same.

export const darkContentColors = {
  editorSurface: '#1e1e1e',
  skillToken: '#8ab4f8',
  skillTokenSurface: 'rgba(59, 130, 246, 0.2)',
  gitDecorationAdded: '#81b88b',
  gitDecorationDeleted: '#c74e39',
  gitDecorationModified: '#e2c08d',
  // GitHub's (Primer) diff colours, Kelvin's choice for every phone diff: row ground, line-number cell over it,
  // the +/− sign, unchanged line numbers, and the blue "unchanged lines" fold band.
  diffAddedBg: 'rgba(46, 160, 67, 0.15)',
  diffDeletedBg: 'rgba(248, 81, 73, 0.13)',
  diffAddedGutter: 'rgba(63, 185, 80, 0.3)',
  diffDeletedGutter: 'rgba(248, 81, 73, 0.3)',
  diffAddedSign: '#3fb950',
  diffDeletedSign: '#f85149',
  diffLineNumber: '#6e7681',
  diffFoldBg: 'rgba(56, 139, 253, 0.1)',
  diffFoldGutter: 'rgba(56, 139, 253, 0.22)',
  diffFoldText: '#4493f8',
  // Desktop's `--chat-diff-*`: decoration mixed toward foreground for tinted rows.
  chatDiffAdded: '#a5ccac',
  chatDiffRemoved: '#d68273',

  // GitHub's Primer dark syntax palette (prettylights); type is its built-in orange, tag covers keys and tag names.
  syntaxComment: '#8b949e',
  syntaxKeyword: '#ff7b72',
  syntaxString: '#a5d6ff',
  syntaxNumber: '#79c0ff',
  syntaxType: '#ffa657',
  syntaxFunction: '#d2a8ff',
  syntaxVariable: '#ffa657',
  syntaxMeta: '#79c0ff',
  syntaxTag: '#7ee787',

  // Terminal WebView background (Tokyonight) — separate from app chrome
  terminalBg: '#1a1b26'
}

export type MobileContentColors = { readonly [K in keyof typeof darkContentColors]: string }

export const lightContentColors: MobileContentColors = {
  editorSurface: '#ffffff',
  skillToken: '#1d4ed8',
  skillTokenSurface: 'rgba(59, 130, 246, 0.12)',
  gitDecorationAdded: '#587c0c',
  gitDecorationDeleted: '#ad0707',
  gitDecorationModified: '#895503',
  diffAddedBg: '#dafbe1',
  diffDeletedBg: '#ffebe9',
  diffAddedGutter: '#aceebb',
  diffDeletedGutter: '#ffcecb',
  diffAddedSign: '#1a7f37',
  diffDeletedSign: '#cf222e',
  diffLineNumber: '#6e7781',
  diffFoldBg: '#ddf4ff',
  diffFoldGutter: 'rgba(84, 174, 255, 0.4)',
  diffFoldText: '#0969da',
  chatDiffAdded: '#415a0b',
  chatDiffRemoved: '#7c0808',

  // GitHub's Primer light syntax palette (prettylights).
  syntaxComment: '#59636e',
  syntaxKeyword: '#cf222e',
  syntaxString: '#0a3069',
  syntaxNumber: '#0550ae',
  syntaxType: '#953800',
  syntaxFunction: '#8250df',
  syntaxVariable: '#953800',
  syntaxMeta: '#0550ae',
  syntaxTag: '#116329',

  terminalBg: '#1a1b26'
}
