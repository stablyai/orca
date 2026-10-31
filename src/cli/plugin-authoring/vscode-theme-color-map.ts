import type { PLUGIN_APP_THEME_TOKENS } from '../../shared/plugins/artifacts/plugin-theme-artifact'
import type { TerminalColorOverrides } from '../../shared/terminal-color-overrides'

type AppThemeToken = (typeof PLUGIN_APP_THEME_TOKENS)[number]

/**
 * VS Code workbench color keys that fill each Orca app theme token; the first key the theme sets
 * wins. Tokens left out here are derived by Orca from `--background` and `--foreground`. New public
 * tokens get a row here so imported themes pick them up.
 */
export const VSCODE_APP_THEME_COLORS: Partial<Record<AppThemeToken, readonly string[]>> = {
  '--background': ['editor.background'],
  '--editor-surface': ['editor.background'],
  '--foreground': ['editor.foreground', 'foreground'],
  '--card': ['editorGroupHeader.tabsBackground', 'panel.background'],
  '--popover': ['editorWidget.background', 'menu.background', 'quickInput.background'],
  '--popover-foreground': ['editorWidget.foreground', 'menu.foreground', 'quickInput.foreground'],
  '--primary': ['button.background'],
  '--primary-foreground': ['button.foreground'],
  '--secondary': ['button.secondaryBackground'],
  '--secondary-foreground': ['button.secondaryForeground'],
  '--muted': ['input.background'],
  '--muted-foreground': ['descriptionForeground', 'editorLineNumber.foreground'],
  '--accent': ['list.hoverBackground', 'list.inactiveSelectionBackground'],
  '--accent-foreground': ['list.hoverForeground'],
  '--border': ['panel.border', 'editorGroup.border', 'widget.border', 'contrastBorder'],
  '--input': ['input.border'],
  '--ring': ['focusBorder'],
  '--chart-1': ['charts.blue'],
  '--chart-2': ['charts.green'],
  '--chart-3': ['charts.yellow'],
  '--chart-4': ['charts.purple'],
  '--chart-5': ['charts.orange'],
  '--sidebar': ['sideBar.background'],
  '--sidebar-foreground': ['sideBar.foreground'],
  '--sidebar-border': ['sideBar.border']
}

/** Tokens that may stay translucent; Orca requires every other token to be opaque. */
export const TRANSLUCENT_APP_THEME_TOKENS: ReadonlySet<string> = new Set([
  '--border',
  '--input',
  '--sidebar-border'
])

/** VS Code keys for each terminal palette slot, first set wins; the editor colors fill in. */
export const VSCODE_TERMINAL_COLORS: Record<keyof TerminalColorOverrides, readonly string[]> = {
  background: ['terminal.background', 'panel.background', 'editor.background'],
  foreground: ['terminal.foreground', 'editor.foreground', 'foreground'],
  cursor: ['terminalCursor.foreground', 'editorCursor.foreground'],
  cursorAccent: ['terminalCursor.background'],
  selectionBackground: ['terminal.selectionBackground', 'editor.selectionBackground'],
  selectionForeground: ['terminal.selectionForeground'],
  black: ['terminal.ansiBlack'],
  red: ['terminal.ansiRed'],
  green: ['terminal.ansiGreen'],
  yellow: ['terminal.ansiYellow'],
  blue: ['terminal.ansiBlue'],
  magenta: ['terminal.ansiMagenta'],
  cyan: ['terminal.ansiCyan'],
  white: ['terminal.ansiWhite'],
  brightBlack: ['terminal.ansiBrightBlack'],
  brightRed: ['terminal.ansiBrightRed'],
  brightGreen: ['terminal.ansiBrightGreen'],
  brightYellow: ['terminal.ansiBrightYellow'],
  brightBlue: ['terminal.ansiBrightBlue'],
  brightMagenta: ['terminal.ansiBrightMagenta'],
  brightCyan: ['terminal.ansiBrightCyan'],
  brightWhite: ['terminal.ansiBrightWhite'],
  bold: []
}
