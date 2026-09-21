/**
 * What still reaches `react-native-webview` in the session closure, named one module at a time.
 *
 * On the web that package renders the line "React Native WebView does not support this platform"
 * where its consumer was, so a page does not go down over one — but nothing it was mounted for
 * works either, and the closure pays for a module that cannot do its job.
 *
 * C7.6 gave the two editors the plain states they already degrade to (`rulings-ota-c7.md` ruling
 * 8) and left the terminal listed as the work remaining, which was C7.5's. C7.5 has done it: the
 * page mounts xterm in the document and drops the engine string, so the list is now empty and
 * this closure reaches that package from nowhere at all.
 *
 * An empty list is also what a scan that read nothing reports, so the control below no longer
 * uses the list — it runs the same walk over three native modules that do import the package and
 * over the three web siblings that replace them.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const SESSION = 'app/h/[hostId]/session/[worktreeId].tsx'

/** Nothing: every consumer this closure had now resolves to a web sibling that needs no WebView. */
const REMAINING = []

/** The three answered, whose `.web.tsx` the builder resolves instead of the native file. */
const ANSWERED = [
  'src/components/MobileRichMarkdownEditor.web.tsx',
  'src/components/MobileHtmlPreview.web.tsx',
  'src/terminal/TerminalWebView.web.tsx'
]

/** The native files behind those three, which do import the package. The scan's own control. */
const NATIVE_CONSUMERS = [
  'src/components/MobileRichMarkdownEditor.tsx',
  'src/components/MobileHtmlPreview.tsx',
  'src/terminal/TerminalWebView.tsx'
]

const IMPORTS_WEBVIEW = /(?:from|import)\s*'[^']*react-native-webview'/

function webViewConsumers(closure) {
  return closure.local.filter((file) => {
    try {
      return IMPORTS_WEBVIEW.test(readFileSync(join(mobileDir, file), 'utf8'))
    } catch {
      return false
    }
  })
}

describeClosure(
  'the session closure and react-native-webview',
  () => {
    it('reaches it from nothing at all', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(webViewConsumers(closure)).toEqual(REMAINING)
      // The precondition an empty list needs: the walk read a closure, and read the very modules
      // whose native halves are the ones that would have imported the package.
      expect(closure.local.length).toBeGreaterThan(500)
      for (const file of ANSWERED) {
        expect(closure.local, file).toContain(file)
      }
    })

    it('resolves both editors to their web siblings, not to the native files', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      for (const file of ANSWERED) {
        expect(closure.local, file).toContain(file)
        expect(closure.local, file).not.toContain(file.replace('.web.tsx', '.tsx'))
      }
    })

    it('finds a consumer when there is one, so the empty list above is a measurement', () => {
      // The control, run over the native files rather than over the list: with the list empty,
      // walking it would compare nothing against nothing and pass on a scan that reads no file.
      expect(webViewConsumers({ local: NATIVE_CONSUMERS })).toEqual(NATIVE_CONSUMERS)
      expect(webViewConsumers({ local: ANSWERED })).toEqual([])
    })
  },
  240_000
)
