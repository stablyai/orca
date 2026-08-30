import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Guard the envelope chokepoint at the tree level rather than per call site.
 *
 * `ipcRenderer.invoke` rejects with Electron's envelope, and the renderer's ordinary idiom renders
 * `err.message`. That made the leak unfixable per site: the shape that leaks is the shape that is
 * correct everywhere else, so a lint rule keyed on it fires on hundreds of sound lines. Routing the
 * 731 call sites through one wrapper fixed them at once — this test is what stops the 732nd from
 * being written outside it.
 *
 * ## What each assertion is worth
 *
 * Two of the three arms below are text scans, and a text scan cannot enumerate the ways JavaScript
 * spells a member access. Two separate bypasses have already been demonstrated against this file:
 * a cast with an aliased receiver, which a `window`-anchored pattern missed, and a computed access
 * whose keys are string literals (`w['electron']['ipcRenderer']['invoke']`), which the scan's own
 * string-blanking step erased before matching. The second one passed 3/3 green with a live escape
 * in the tree. Patching a third spelling would not change the shape: `'ipc' + 'Renderer'` walks
 * past any regex, and so does any key read from a variable.
 *
 * So the arms are labelled for what they are, not for what would be reassuring:
 *
 * - `stays behind the boundary` is a **fence**. `ipcRenderer` is only importable in preload, and
 *   preload is three modules; a text scan is proportionate there and there is nowhere to hide.
 * - `the main world gets exactly these globals` is a **fence**, and the load-bearing one. Under
 *   context isolation `exposeInMainWorld` is the only way to put anything in the renderer's world,
 *   so the doors are enumerable, they all live in one file, and widening the set is a one-line diff
 *   in the module a reviewer reads most closely.
 * - `is not reached through the raw bridge` is a **tripwire**, and is documented as one. It catches
 *   somebody reaching for `window.electron.ipcRenderer` without thinking. It does not survive
 *   somebody who means it, and it must not be read as though it does.
 *
 * The residue this cannot close: `window.electron` really is a live door to a raw `ipcRenderer`,
 * and no scan of renderer source will hold it shut. The only thing that closes it is not opening
 * it — nothing in the tree reads `window.electron` today, so the exposure could be dropped. That is
 * a change to the app's global surface rather than to this fix, so it is recorded here as the
 * standing recommendation and not smuggled in.
 */
const BOUNDARY_MODULE = 'src/preload/ipc-invoke-boundary.ts'
const SRC_ROOT = resolve(__dirname, '..')
const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'out',
  'build',
  '.git',
  '__fixtures__'
])

/** Whitespace and newlines are legal between the receiver and the call, and one call site used them. */
const RAW_INVOKE = /ipcRenderer\s*\.\s*invoke\s*\(/
/**
 * Two spellings, both of which were live escapes before they were added, and neither of which makes
 * this arm complete — see the note above. Dot form is not anchored on `window`, because a cast sits
 * between `window` and `.electron`; the lookbehind keeps `electronFoo.ipcRenderer` out. Quoted-key
 * form is matched against source that still has its strings, because blanking them is exactly what
 * hid `['electron']['ipcRenderer']`. Typing the global closes neither: `Window.electron` IS declared
 * (`src/preload/api-types.ts`), so the plain spelling already compiles.
 */
const RAW_BRIDGE_DOT = /(?<!\w)electron\s*\.\s*ipcRenderer/
const RAW_BRIDGE_COMPUTED = /\[\s*(['"`])ipcRenderer\1\s*\]/

/** The complete set of names preload puts in the renderer's world, by either code path. */
const MAIN_WORLD_GLOBALS = ['api', 'electron']
const PRELOAD_ENTRY = 'src/preload/index.ts'

/**
 * Comments name this shape on purpose — the modules that consume the envelope explain where it
 * comes from — so the scan reads code only. A ratchet that fired on prose would be silenced by
 * rewording rather than by fixing anything.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function withoutCommentsOrStrings(source: string): string {
  return withoutComments(source).replace(
    /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g,
    "''"
  )
}

/** Tests may reach for the raw call: they are not shipped, and several drive it to prove the wrapper. */
function isTestFile(path: string): boolean {
  return /\.(?:test|spec)\.tsx?$/.test(path) || path.includes('/__tests__/')
}

function collectSourceFiles(root: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(root)) {
    if (IGNORED_DIRECTORIES.has(entry)) {
      continue
    }
    const full = join(root, entry)
    if (statSync(full).isDirectory()) {
      found.push(...collectSourceFiles(full))
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext)) && !isTestFile(full)) {
      found.push(full)
    }
  }
  return found
}

function offendingModules(pattern: RegExp, scrub = withoutCommentsOrStrings): string[] {
  return collectSourceFiles(SRC_ROOT)
    .filter((file) => pattern.test(scrub(readFileSync(file, 'utf8'))))
    .map((file) => relative(resolve(SRC_ROOT, '..'), file).replaceAll('\\', '/'))
    .sort()
}

/** Every name preload hands the renderer: the `exposeInMainWorld` pair and the fallback assignment. */
function exposedMainWorldGlobals(): string[] {
  const source = withoutComments(readFileSync(join(SRC_ROOT, 'preload', 'index.ts'), 'utf8'))
  const names = new Set<string>()
  for (const [, name] of source.matchAll(/exposeInMainWorld\s*\(\s*['"`]([\w$]+)['"`]/g)) {
    names.add(name)
  }
  for (const [, name] of source.matchAll(/(?:^|\n)\s*window\s*\.\s*([\w$]+)\s*=[^=]/g)) {
    names.add(name)
  }
  return [...names].sort()
}

describe('ipcRenderer.invoke stays behind the preload boundary', () => {
  it('is called in exactly one module', () => {
    expect(offendingModules(RAW_INVOKE)).toEqual([BOUNDARY_MODULE])
  })

  /**
   * A tripwire, not a fence. It reddens on the two spellings that were demonstrated against it and
   * on the obvious one; it does not claim to redden on a spelling nobody has written yet.
   */
  it('is not reached through the raw electron bridge by any spelling this can see', () => {
    expect(offendingModules(RAW_BRIDGE_DOT)).toEqual([])
    expect(offendingModules(RAW_BRIDGE_COMPUTED, withoutComments)).toEqual([])
  })

  /**
   * The arm that actually holds. `exposeInMainWorld` is the only way into an isolated renderer's
   * world, every call is in one file, and a new door has to be spelled out here to exist at all.
   */
  it('gives the main world exactly these globals, from exactly one module', () => {
    expect(exposedMainWorldGlobals()).toEqual(MAIN_WORLD_GLOBALS)
    expect(offendingModules(/exposeInMainWorld\s*\(/)).toEqual([PRELOAD_ENTRY])
  })

  /** A scan that matched nothing anywhere would pass both assertions above while enforcing nothing. */
  it('scans the modules it claims to', () => {
    const files = collectSourceFiles(SRC_ROOT)

    expect(files.length).toBeGreaterThan(500)
    expect(files.some((file) => file.endsWith('preload/index.ts'))).toBe(true)
    expect(files.some((file) => file.endsWith('preload/gitlab.ts'))).toBe(true)
  })
})
