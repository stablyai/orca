import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  textInputFontSizeOffenders,
  unresolvedTextInputStyles
} from './mobile-web-app-text-input-font-size-seam.mjs'

/**
 * What putting the terminal on the page costs the session route's closure.
 *
 * The route is not served on the page until C7.7 — its module is still the native switch and
 * there is no `.web.tsx` beside it — but the closure the bundler would walk is the same one, and
 * the terminal is by far the largest thing in it. Measured here so the trade is a number rather
 * than a claim, and so that a later change cannot quietly put the engine string back.
 *
 * Measured against `origin/main` at 9fbdfc592c, which is the merge base this branch now sits on:
 *
 *   modules        4277 -> 4320   (+43)
 *   local modules   926 ->  970   (+44)
 *   minified bytes  3,868,833 -> 3,812,418   (-56,415)
 *
 * The route gets smaller. It sheds six modules — the native component, the 612 KiB engine string,
 * the 105 KiB generated document script, the HTML module and the shell and close around it, all
 * string literals of a program the page cannot run — and gains fifty: the document's own 39, the
 * component, its mount, the stylesheet and markup, the two the controller split made, and xterm
 * with its two addons behind them at 607,945 bytes minified ESM on their own.
 *
 * Two earlier readings of the same measurement, against the bases this branch sat on before:
 * -47,255 at 51ae7b1b03 and -55,561 at 0ce0fc99a2. They differ because C7.1's own round-1 fold
 * deleted `URL_TAP_WEBVIEW_JS` from a module only the page's component brings into this closure,
 * so the saving lands on the after side and no base can show it.
 */

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const mobileDir = join(projectDir, 'mobile')

const SESSION_ROUTE = 'app/h/[hostId]/session/[worktreeId].tsx'

/** Gone with the WebView: string literals of a program the page has no way to run. */
const SHED = [
  'src/terminal/TerminalWebView.tsx',
  'src/terminal/terminal-webview-engine.generated.ts',
  'src/terminal/terminal-webview-document-script.generated.ts',
  'src/terminal/terminal-webview-html.ts',
  'src/terminal/terminal-webview-html/document-shell.ts',
  'src/terminal/terminal-webview-html/document-close.ts'
]

/** The component, its mount, the stylesheet and the markup, and the modules the splits made. */
const GAINED_OUTSIDE_THE_DOCUMENT = [
  'src/terminal/TerminalWebView.web.tsx',
  'src/terminal/terminal-web-document-mount.ts',
  'src/terminal/terminal-webview-engine-css.generated.ts',
  'src/terminal/terminal-webview-html.web.ts',
  'src/terminal/terminal-webview-html/document-markup.ts',
  'src/terminal/terminal-webview-html/document-style.ts',
  // The page's half of the stylesheet: the document-level rules are dropped and the rest is held
  // under the host, so what the page injects can only reach what the terminal owns.
  'src/terminal/terminal-webview-html/document-style-scoping.ts',
  'src/terminal/terminal-webview-ready-promises.ts',
  'src/terminal/use-terminal-webview-controller.ts'
]

const XTERM_PACKAGES = ['@xterm/xterm', '@xterm/addon-unicode11', '@xterm/addon-webgl']

/**
 * The 16 px seam's verdict for this route, which C7.5 must leave exactly where C7.2 left it.
 *
 * Design §3 counted nine inputs under the floor here and C7.2 moved all nine onto the seam, so the
 * answer is now none. Asserted rather than left unmeasured because the terminal's own modules
 * joining this closure is precisely the kind of change that could add a tenth unread.
 */
const EXPECTED_OFFENDERS = 0

const bundles = mobileWebAppDependenciesPresent()
const describeClosure = bundles ? describe : describe.skip

describeClosure(
  "the session route's page closure with the terminal on it",
  () => {
    it('gains the document, xterm and the addons, and sheds the engine string', async () => {
      const { local, modules } = await mobileWebAppRouteClosure(SESSION_ROUTE)
      for (const gone of SHED) {
        expect(local, `${gone} is still in the closure`).not.toContain(gone)
      }
      for (const gained of GAINED_OUTSIDE_THE_DOCUMENT) {
        expect(local, `${gained} is not in the closure`).toContain(gained)
      }
      for (const name of XTERM_PACKAGES) {
        expect(
          modules.some((module) => module.includes(`node_modules/${name}/`)),
          `${name} is not in the closure`
        ).toBe(true)
      }
      // The document, whole: every module the generator emits except the bridge, which ruling 19
      // keeps off the page because those `message` frames belong to the shell.
      const documentModules = local.filter((module) => module.startsWith('src/terminal/document/'))
      expect(documentModules.length).toBeGreaterThanOrEqual(36)
      expect(documentModules).not.toContain('src/terminal/document/message-bridge.ts')
      expect(documentModules).toContain('src/terminal/document/page-document-modules.ts')
    }, 300_000)

    it('leaves the 16px seam census exactly where C7.2 left it', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION_ROUTE)
      // Two preconditions, because zero offenders is what a walk that read nothing also reports:
      // the seam's own web module has to be in the closure, and no style may be unresolved.
      expect(closure.local).toContain('src/platform/text-input-font-size.web.ts')
      expect(unresolvedTextInputStyles(mobileDir, closure)).toEqual([])
      expect(textInputFontSizeOffenders(mobileDir, closure)).toHaveLength(EXPECTED_OFFENDERS)
    }, 300_000)
  },
  900_000
)
