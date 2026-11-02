/**
 * `orca plugin check` for custom editors, without a running Orca: every file an editor entry
 * loads (its local `<script src>`, inline module scripts, and their relative imports) is
 * transpiled and resolved exactly as the frame loader does. Shipped in orca-test-hooks.mjs.
 */
import { realpathSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { posix, relative, resolve, sep } from 'node:path'
import { resolvePluginModuleSpecifier } from '../panels/plugin-frame-module-resolution'
import { parsePluginTranspileFailure } from '../panels/plugin-source-transpile-failure'
import { transpilePluginSource } from '../panels/plugin-source-transpiler'
import {
  PLUGIN_PANEL_ENTRY_MAX_BYTES,
  PLUGIN_SOURCE_MODULE_MAX_BYTES
} from '../../../shared/plugins/frames/plugin-frame-entry-limits'
import { isPluginSourceModulePath } from '../../../shared/plugins/frames/plugin-frame-source-modules'

export type PluginEditorCheckIssueCode =
  | 'editor_syntax'
  | 'editor_missing_file'
  | 'editor_import'
  | 'editor_eval'
  | 'editor_too_large'

export type PluginEditorCheckIssue = {
  code: PluginEditorCheckIssueCode
  message: string
  /** `file:line:column` inside the plugin. */
  location: string
}

export type PluginEditorStaticCheck = { files: string[]; issues: PluginEditorCheckIssue[] }

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/i
const HTML = /\.html?$/i
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
// Why: the frame's content policy has no 'unsafe-eval', so these throw when they run.
const EVAL_CALL = /(?<![\w$.])(?:eval|Function)\s*\(|\bnew\s+Function\b/g

function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset).split('\n')
  return { line: before.length, column: (before.at(-1)?.length ?? 0) + 1 }
}

/** Code with comments and string contents blanked (lengths and lines kept). */
function codeOnly(code: string): string {
  let out = ''
  let i = 0
  while (i < code.length) {
    const two = code.slice(i, i + 2)
    const quote = code[i]
    if (two === '//' || two === '/*') {
      const end = two === '//' ? code.indexOf('\n', i) : code.indexOf('*/', i + 2) + 2
      const stop = end <= 1 || end === -1 ? code.length : end
      out += code.slice(i, stop).replace(/[^\n]/g, ' ')
      i = stop
    } else if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1
      while (j < code.length && code[j] !== quote) {
        j += code[j] === '\\' ? 2 : 1
      }
      out += quote + code.slice(i + 1, j).replace(/[^\n]/g, ' ') + quote
      i = j + 1
    } else {
      out += quote
      i += 1
    }
  }
  return out
}

type Script = { path: string; text: string; lineOffset: number }

/** Local `<script src>` targets and inline scripts of an HTML entry. */
function htmlScripts(
  path: string,
  html: string
): { srcs: { src: string; at: string }[]; inline: Script[] } {
  const srcs: { src: string; at: string }[] = []
  const inline: Script[] = []
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const start = lineColumn(html, match.index)
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1])
    const value = src ? (src[1] ?? src[2] ?? src[3] ?? '') : null
    if (value !== null) {
      if (!URL_LIKE.test(value)) {
        srcs.push({ src: value, at: `${path}:${start.line}:${start.column}` })
      }
    } else if (match[2].trim()) {
      const contentStart = match.index + match[0].indexOf('>') + 1
      inline.push({ path, text: match[2], lineOffset: lineColumn(html, contentStart).line - 1 })
    }
  }
  return { srcs, inline }
}

export async function checkPluginEditorEntry(
  pluginDir: string,
  entry: string
): Promise<PluginEditorStaticCheck> {
  const root = realpathSync(pluginDir)
  const issues: PluginEditorCheckIssue[] = []
  const seen = new Set<string>()
  const absolute = (path: string): string => resolve(root, ...path.split('/'))
  const inside = (path: string): boolean => {
    const rel = relative(root, absolute(path))
    return rel !== '' && !rel.startsWith('..') && !rel.split(sep).includes('..')
  }
  const exists = async (path: string): Promise<boolean> =>
    inside(path) &&
    (await stat(absolute(path)).then(
      (s) => s.isFile(),
      () => false
    ))

  /** The file's text, or null after reporting why it cannot load. */
  async function read(path: string, at: string): Promise<string | null> {
    if (!(await exists(path))) {
      issues.push({
        code: 'editor_missing_file',
        message: `${path} does not exist in the plugin`,
        location: at
      })
      return null
    }
    const { size } = await stat(absolute(path))
    // Orca transpiles source modules whole, so they get the tighter cap.
    const cap = isPluginSourceModulePath(path)
      ? PLUGIN_SOURCE_MODULE_MAX_BYTES
      : PLUGIN_PANEL_ENTRY_MAX_BYTES
    if (size > cap) {
      issues.push({
        code: 'editor_too_large',
        message: `${path} is ${size} bytes; Orca loads at most ${cap / 1024 / 1024} MiB for this file`,
        location: at
      })
      return null
    }
    return readFile(absolute(path), 'utf8')
  }

  async function checkScript({ path, text, lineOffset }: Script, from: string): Promise<void> {
    const where = (line: number, column: number) => `${path}:${line + lineOffset}:${column}`
    // An inline script parses as plain JavaScript.
    const source = SCRIPT.test(path) ? path : `${path}.js`
    const transpiled = transpilePluginSource(source, text)
    if (!transpiled.ok) {
      const failure = parsePluginTranspileFailure(source, transpiled.message)
      issues.push({
        code: 'editor_syntax',
        message: failure.message,
        location: failure.at ? where(failure.at.line, failure.at.column) : where(1, 1)
      })
      return
    }
    for (const match of codeOnly(transpiled.code).matchAll(EVAL_CALL)) {
      const at = lineColumn(transpiled.code, match.index)
      issues.push({
        code: 'editor_eval',
        message: `${match[0].replace(/\s*\($/, '')} compiles a string, which the editor frame refuses`,
        location: where(at.line, at.column)
      })
    }
    for (const { specifier, start } of transpiled.imports) {
      const at = lineColumn(transpiled.code, start)
      const resolution = await resolvePluginModuleSpecifier(from, specifier, exists)
      if (resolution.kind === 'refuse') {
        issues.push({
          code: 'editor_import',
          message: resolution.reason,
          location: where(at.line, at.column)
        })
      } else if (resolution.kind === 'rewrite') {
        const [target] = resolution.specifier.split(/[?#]/, 1)
        await visit(
          posix.join(posix.dirname(from), decodeURIComponent(target)),
          where(at.line, at.column)
        )
      }
    }
  }

  async function visit(path: string, at: string): Promise<void> {
    if (seen.has(path)) {
      return
    }
    seen.add(path)
    const text = await read(path, at)
    if (text === null) {
      return
    }
    if (!HTML.test(path)) {
      await checkScript({ path, text, lineOffset: 0 }, path)
      return
    }
    const { srcs, inline } = htmlScripts(path, text)
    for (const script of inline) {
      await checkScript(script, path)
    }
    for (const { src, at: srcAt } of srcs) {
      const [pathPart] = src.split(/[?#]/, 1)
      const target = pathPart.startsWith('/')
        ? posix.normalize(pathPart.slice(1))
        : posix.join(posix.dirname(path), pathPart)
      if (target.startsWith('../') || target === '..') {
        issues.push({
          code: 'editor_import',
          message: `<script src="${src}"> is outside the plugin`,
          location: srcAt
        })
      } else {
        await visit(target, srcAt)
      }
    }
  }

  await visit(posix.normalize(entry), 'orca-plugin.json')
  return { files: [...seen].sort(), issues }
}
