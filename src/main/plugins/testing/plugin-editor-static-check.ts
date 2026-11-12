/**
 * `orca plugin check` for custom editors, without a running Orca: every file an editor entry
 * loads (its local `<script src>`, inline module scripts, and their relative imports) is
 * transpiled and resolved exactly as the frame loader does. Shipped in orca-test-hooks.mjs.
 */
import { realpathSync } from 'node:fs'
import { posix } from 'node:path'
import { resolvePluginModuleSpecifier } from '../panels/frame-serving/plugin-frame-module-resolution'
import { parsePluginTranspileFailure } from '../panels/source-transpilation/plugin-source-transpile-failure'
import { transpilePluginSource } from '../panels/source-transpilation/plugin-source-transpiler'
import {
  PLUGIN_FRAME_ASSET_MAX_BYTES,
  PLUGIN_FRAME_CHECKED_MAX_BYTES,
  PLUGIN_PANEL_ENTRY_MAX_BYTES,
  PLUGIN_SOURCE_MODULE_MAX_BYTES
} from '../../../shared/plugins/frames/plugin-frame-entry-limits'
import {
  isCheckedPluginFrameType,
  pluginFrameContentType
} from '../panels/frame-serving/plugin-frame-content-types'
import {
  readContainedPluginArtifactText,
  resolveContainedPluginArtifact
} from '../plugin-contained-artifact'
import {
  lineColumn,
  readHtmlScripts,
  resolveImportMapSpecifier,
  type HtmlImportMap
} from './plugin-editor-html-scripts'
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

export type PluginEditorStaticCheck = {
  files: string[]
  issues: PluginEditorCheckIssue[]
  /** Found by a lexical scan that can misread rare code, so they do not fail the check. */
  warnings: PluginEditorCheckIssue[]
}

const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
// Why: the frame's content policy has no 'unsafe-eval', so these throw when they run.
const EVAL_CALL = /(?<![\w$.])(?:eval|Function)\s*\(|\bnew\s+Function\b/g

type FileKind = 'document' | 'source' | 'script' | 'json' | 'asset'

/** How the frame protocol treats the file: the entry is a page, `.ts`-family files are
 *  transpiled, and anything else goes by its served content type. */
function fileKind(path: string, isEntry: boolean): FileKind {
  if (isPluginSourceModulePath(path)) {
    return 'source'
  }
  if (isEntry) {
    return 'document'
  }
  const type = pluginFrameContentType(path)
  return type.startsWith('text/javascript')
    ? 'script'
    : type.startsWith('application/json')
      ? 'json'
      : 'asset'
}

/** The protocol's caps: the entry, a transpiled module, and checked or streamed dependencies. */
function capFor(kind: FileKind, path: string): number {
  if (kind === 'document') {
    return PLUGIN_PANEL_ENTRY_MAX_BYTES
  }
  if (kind === 'source') {
    return PLUGIN_SOURCE_MODULE_MAX_BYTES
  }
  return isCheckedPluginFrameType(pluginFrameContentType(path))
    ? PLUGIN_FRAME_CHECKED_MAX_BYTES
    : PLUGIN_FRAME_ASSET_MAX_BYTES
}

/** A URL path from `from`, decoded, as a plugin path; null when it leaves the plugin. */
function pluginPathOf(from: string, reference: string): string | null {
  const [pathPart = ''] = reference.split(/[?#]/, 1)
  const decoded = decodeURIComponent(pathPart)
  const target = decoded.startsWith('/')
    ? posix.normalize(decoded.slice(1))
    : posix.join(posix.dirname(from), decoded)
  return target === '..' || target.startsWith('../') ? null : target
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

type Script = { path: string; text: string; lineOffset: number; native: boolean }
type NativeImport = { path: string } | { keep: true } | { refuse: string }

export async function checkPluginEditorEntry(
  pluginDir: string,
  entry: string
): Promise<PluginEditorStaticCheck> {
  const root = realpathSync(pluginDir)
  const issues: PluginEditorCheckIssue[] = []
  const warnings: PluginEditorCheckIssue[] = []
  const seen = new Set<string>()
  const entryPath = posix.normalize(entry)
  // Document-wide, as in Chromium: it maps every native module's bare imports.
  let importMap: HtmlImportMap = {}
  const exists = (path: string): Promise<boolean> =>
    resolveContainedPluginArtifact(root, path).then(
      () => true,
      () => false
    )
  const issue = (code: PluginEditorCheckIssueCode, message: string, location: string): void => {
    issues.push({ code, message, location })
  }

  /** The file's text through the loader's contained reader, or null after reporting why not. */
  async function read(path: string, cap: number, at: string): Promise<string | null> {
    try {
      return await readContainedPluginArtifactText(root, path, cap)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        issue('editor_missing_file', `${path} does not exist in the plugin`, at)
      } else if (message.includes('artifact limit')) {
        const mib = cap / 1024 / 1024
        issue('editor_too_large', `${path} is over the ${mib} MiB Orca loads for this file`, at)
      } else {
        issue('editor_import', `${path} ${message}`, at)
      }
      return null
    }
  }

  /** Where a native (untranspiled) module's import goes, as Chromium resolves it. */
  function nativeImport(from: string, specifier: string): NativeImport {
    if (URL_LIKE.test(specifier)) {
      return { keep: true }
    }
    const relativeImport = /^\.{0,2}\//.test(specifier)
    const mapped = relativeImport ? null : resolveImportMapSpecifier(importMap, specifier)
    if (!relativeImport && mapped === null) {
      return {
        refuse: `cannot import "${specifier}": a bare name needs an entry in the page's import map`
      }
    }
    if (mapped !== null && URL_LIKE.test(mapped)) {
      return { keep: true }
    }
    const path = mapped === null ? pluginPathOf(from, specifier) : pluginPathOf(entryPath, mapped)
    return path === null
      ? { refuse: `cannot import "${specifier}": it is outside the plugin` }
      : { path }
  }

  async function checkImports(
    path: string,
    native: boolean,
    imports: readonly { specifier: string; at: string }[]
  ): Promise<void> {
    for (const { specifier, at } of imports) {
      if (native) {
        const target = nativeImport(path, specifier)
        if ('refuse' in target) {
          issue('editor_import', target.refuse, at)
        } else if ('path' in target) {
          await visit(target.path, at)
        }
        continue
      }
      const resolution = await resolvePluginModuleSpecifier(path, specifier, exists)
      if (resolution.kind === 'refuse') {
        issue('editor_import', resolution.reason, at)
      } else if (resolution.kind === 'rewrite') {
        const [target = ''] = resolution.specifier.split(/[?#]/, 1)
        await visit(posix.join(posix.dirname(path), decodeURIComponent(target)), at)
      }
    }
  }

  async function checkScript({ path, text, lineOffset, native }: Script): Promise<void> {
    const where = (line: number, column: number) => `${path}:${line + lineOffset}:${column}`
    // A native script parses as plain JavaScript, whatever its name.
    const source = native ? `${path}.js` : path
    const transpiled = transpilePluginSource(source, text)
    if (!transpiled.ok) {
      const failure = parsePluginTranspileFailure(source, transpiled.message)
      const at = failure.at ? where(failure.at.line, failure.at.column) : where(1, 1)
      issue('editor_syntax', failure.message, at)
      return
    }
    for (const match of codeOnly(transpiled.code).matchAll(EVAL_CALL)) {
      const at = lineColumn(transpiled.code, match.index)
      warnings.push({
        code: 'editor_eval',
        message: `${match[0].replace(/\s*\($/, '')} compiles a string, which the editor frame refuses`,
        location: where(at.line, at.column)
      })
    }
    const imports = transpiled.imports.map(({ specifier, start }) => {
      const position = lineColumn(transpiled.code, start)
      return { specifier, at: where(position.line, position.column) }
    })
    await checkImports(path, native, imports)
  }

  async function checkDocument(path: string, html: string): Promise<void> {
    const scripts = readHtmlScripts(html)
    importMap = { ...scripts.importMap, ...importMap }
    for (const script of scripts.inline) {
      await checkScript({ path, text: script.text, lineOffset: script.lineOffset, native: true })
    }
    for (const { src, line, column } of scripts.srcs) {
      const at = `${path}:${line}:${column}`
      if (URL_LIKE.test(src)) {
        continue
      }
      let target: string | null
      try {
        target = pluginPathOf(path, src)
      } catch {
        issue('editor_import', `<script src="${src}"> has a malformed escape`, at)
        continue
      }
      if (target === null) {
        issue('editor_import', `<script src="${src}"> is outside the plugin`, at)
      } else {
        await visit(target, at)
      }
    }
  }

  async function visit(path: string, at: string): Promise<void> {
    if (seen.has(path)) {
      return
    }
    seen.add(path)
    const kind = fileKind(path, path === entryPath)
    const text = await read(path, capFor(kind, path), at)
    if (text === null || kind === 'asset') {
      return
    }
    if (kind === 'document') {
      await checkDocument(path, text)
    } else if (kind === 'json') {
      try {
        JSON.parse(text)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        issue('editor_syntax', message, `${path}:1:1`)
      }
    } else {
      await checkScript({ path, text, lineOffset: 0, native: kind === 'script' })
    }
  }

  await visit(entryPath, 'orca-plugin.json')
  return { files: [...seen].sort(), issues, warnings }
}
