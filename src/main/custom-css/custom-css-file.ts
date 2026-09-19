import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  CUSTOM_CSS_FILE_NAME,
  CUSTOM_CSS_MAX_BYTES,
  type CustomCssSnapshot
} from '../../shared/custom-css'

const CUSTOM_CSS_TEMPLATE = `/*
 * Orca custom stylesheet — loaded after the built-in theme when
 * Settings → Appearance → Custom CSS is on, and reloaded on save.
 *
 * The UI colors come from the variables below. Variable names are internal
 * and may change between releases. url() accepts only inline data: URLs
 * (remote, relative and file:// are dropped), and @import is ignored.
 */

/* Light theme */
:root {
  /* --background: #fff; */
  /* --foreground: #0a0a0a; */
  /* --border: #e5e5e5; */
  /* --accent: #f5f5f5; */
  /* --sidebar: #fafafa; */
  /* --worktree-sidebar: #f5f5f5; */
  /* --worktree-sidebar-border: #e5e5e5; */
}

/* Dark theme */
.dark {
  /* --background: #0a0a0a; */
  /* --foreground: #fafafa; */
  /* --border: rgb(255 255 255 / 0.07); */
  /* --accent: #404040; */
  /* --sidebar: #171717; */
  /* --worktree-sidebar: #2a2a2a; */
  /* --worktree-sidebar-border: rgb(255 255 255 / 0.07); */
}
`

export function getUserCustomCssPath(homePath: string): string {
  // Why: next to keybindings.json, the documented home for user-editable Orca files.
  return join(homePath, '.orca', CUSTOM_CSS_FILE_NAME)
}

export function readCustomCssFile(path: string): CustomCssSnapshot {
  if (!existsSync(path)) {
    return { path, exists: false, css: '', error: null }
  }
  try {
    const { size } = statSync(path)
    if (size > CUSTOM_CSS_MAX_BYTES) {
      return { path, exists: true, css: '', error: { kind: 'too-large', sizeBytes: size } }
    }
    return { path, exists: true, css: readFileSync(path, 'utf8'), error: null }
  } catch (error) {
    return {
      path,
      exists: true,
      css: '',
      error: { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) }
    }
  }
}

export function ensureCustomCssFile(path: string): void {
  if (existsSync(path)) {
    return
  }
  mkdirSync(dirname(path), { recursive: true })
  try {
    writeFileSync(path, CUSTOM_CSS_TEMPLATE, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    // Why: another window or the user may create it between the check and the write.
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error
    }
  }
}
