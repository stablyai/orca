import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// RATCHET — this list may only SHRINK. Each entry still imports the frozen dark `colors`
// alias and therefore will not follow the app theme. Delete entries as you convert;
// never add one. Empty list == migration complete.
const UNTHEMED_COLOR_IMPORTERS: readonly string[] = []

// Colour literals allowed to stay literal inside a themed factory, keyed
// `<path>#<factory>#<literal>` with the reason each one is mode-independent. Two fixes in
// this migration were literals that looked fine in dark and broke in light, and no other
// guard sees them: the sheets are byte-identical under dark and the both-palettes suite
// still differs. May only shrink, or grow with a reason.
const MODE_FIXED_FACTORY_LITERALS: Readonly<Record<string, string>> = {
  'app/pair-scan.tsx#createPairScanStyles#rgba(255,255,255,0.7)':
    'reticle over the live camera feed, not over an app surface',
  'src/browser/MobileBrowserPane.tsx#createMobileBrowserPaneStyles#rgba(13, 15, 24, 0.2)':
    'scrim over rendered web content, which is not our palette in either mode',
  'src/browser/MobileBrowserPane.tsx#createMobileBrowserPaneStyles#rgba(13, 15, 24, 0.5)':
    'dialog scrim over rendered web content',
  'src/components/DragReorderList.tsx#createDragReorderListStyles##000':
    'shadowColor — RN shadows are black in both modes',
  'src/components/MobileHtmlPreview.tsx#createMobileHtmlPreviewStyles##ffffff':
    'the preview page canvas; arbitrary HTML assumes a white page',
  'src/components/NewWorkspaceFab.tsx#createNewWorkspaceFabStyles##000': 'shadowColor',
  'src/components/RightDrawer.tsx#createRightDrawerStyles#rgba(0,0,0,0.5)':
    'modal scrim — dark in both modes by design',
  'src/components/RightDrawer.tsx#createRightDrawerStyles##000': 'shadowColor',
  'src/components/bottom-drawer-styles.ts#createBottomDrawerStyles#rgba(0,0,0,0.5)': 'modal scrim',
  'src/components/bottom-drawer-styles.ts#createBottomDrawerStyles##000': 'shadowColor',
  'src/components/terminal-shortcut-settings-styles.ts#createTerminalShortcutSettingsStyles#rgba(239, 68, 68, 0.1)':
    'statusRed wash; still a legible pink over a light surface',
  'src/components/terminal-shortcut-settings-styles.ts#createTerminalShortcutSettingsStyles#rgba(239, 68, 68, 0.2)':
    'statusRed wash'
}

const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g
const FACTORY_DECL = /export (?:const|function) (create[A-Za-z0-9]*Styles)\s*[:=(]/g

const MOBILE_ROOT = path.resolve(__dirname, '../..')
// Matches any relative path ending in mobile-theme (…/theme/mobile-theme or ./mobile-theme).
const BARE_COLORS_IMPORT = /import\s*\{[^}]*\bcolors\b[^}]*\}\s*from\s*['"][^'"]*mobile-theme['"]/
const INLINE_THEMED_STYLES = /useThemedStyles\s*\(\s*(?:\([^)]*\)|[$A-Z_a-z][$\w]*)\s*=>/

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSourceFiles(full, out)
      continue
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      continue
    }
    out.push(full)
  }
  return out
}

function listBareColorsImporters(): string[] {
  const roots = ['app', 'src'].map((segment) => path.join(MOBILE_ROOT, segment))
  const files = roots.flatMap((root) => walkSourceFiles(root))
  return files
    .filter((file) => BARE_COLORS_IMPORT.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(MOBILE_ROOT, file).split(path.sep).join('/'))
    .sort()
}

// Only the StyleSheet.create(...) that follows the declaration, so literals in
// neighbouring component code are not blamed on the sheet.
function sheetBodyAfter(src: string, from: number): string | null {
  const open = src.indexOf('StyleSheet.create(', from)
  if (open === -1) {
    return null
  }
  let depth = 0
  for (let i = open + 'StyleSheet.create('.length - 1; i < src.length; i++) {
    if (src[i] === '(') {
      depth++
    } else if (src[i] === ')') {
      depth--
      if (depth === 0) {
        return src.slice(open, i)
      }
    }
  }
  return null
}

function listFactoryLiterals(): string[] {
  const roots = ['app', 'src'].map((segment) => path.join(MOBILE_ROOT, segment))
  const found: string[] = []
  for (const file of roots.flatMap((root) => walkSourceFiles(root))) {
    const src = fs.readFileSync(file, 'utf8')
    const rel = path.relative(MOBILE_ROOT, file).split(path.sep).join('/')
    FACTORY_DECL.lastIndex = 0
    const declarations = [...src.matchAll(FACTORY_DECL)]
    for (const [i, declaration] of declarations.entries()) {
      // Why the slice bound: a factory that returns a spread instead of its
      // own StyleSheet.create must not adopt the NEXT factory's sheet.
      const nextIndex = declarations[i + 1]?.index ?? src.length
      const scope = src.slice(0, nextIndex)
      const literals = new Set<string>()
      for (let from = declaration.index; ; ) {
        const body = sheetBodyAfter(scope, from)
        if (!body) {
          break
        }
        for (const literal of body.match(COLOUR_LITERAL) ?? []) {
          literals.add(literal)
        }
        from = scope.indexOf(body, from) + body.length
      }
      for (const literal of literals) {
        found.push(`${rel}#${declaration[1]}#${literal}`)
      }
    }
  }
  return found.sort()
}

describe('unthemed color import ratchet', () => {
  it('lists every bare `colors` importer; the baseline may only shrink', () => {
    const actual = listBareColorsImporters()
    const unexpected = actual.filter((p) => !UNTHEMED_COLOR_IMPORTERS.includes(p))
    const convertedButStillListed = UNTHEMED_COLOR_IMPORTERS.filter((p) => !actual.includes(p))
    // Why toEqual([]): failures print the exact offending paths.
    expect(unexpected).toEqual([])
    expect(convertedButStillListed).toEqual([])
  })

  it('keeps colour literals out of themed factories unless they are mode-fixed', () => {
    const actual = listFactoryLiterals()
    const allowed = Object.keys(MODE_FIXED_FACTORY_LITERALS)
    expect(actual.filter((entry) => !allowed.includes(entry))).toEqual([])
    expect(allowed.filter((entry) => !actual.includes(entry))).toEqual([])
  })

  it('forbids inline useThemedStyles(() => …) factories (fresh cache key every render)', () => {
    const roots = ['app', 'src'].map((segment) => path.join(MOBILE_ROOT, segment))
    const offenders = roots
      .flatMap((root) => walkSourceFiles(root))
      .filter((file) => INLINE_THEMED_STYLES.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(MOBILE_ROOT, file).split(path.sep).join('/'))
      .sort()
    expect(offenders).toEqual([])
  })
})
