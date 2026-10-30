import { beforeAll, describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { mobileWebAppRouteChunkClosure } from './mobile-web-app-route-chunk-closure.mjs'

// Require terminal source modules/xterm, excluding WebView engine strings and generated document/factory to avoid shipping document twice.
// Remeasure closure after generators and upstream merges; shared inputs make summed historical module deltas unreliable.
// Input metafile includes dynamic imports: only emitted static import-statement edges prove Mermaid is deferred.
// Prebundle Mermaid as one artifact; package splitting once emitted 103 scripts against shell’s 256-asset limit. Deferral saves fetch/evaluation, not OTA download.

const SESSION_ROUTE = 'app/h/[hostId]/session/[worktreeId].tsx'

// WebView-only generated programs cannot execute in page.
const SHED = [
  'src/terminal/TerminalWebView.tsx',
  'src/terminal/terminal-webview-engine.generated.ts',
  'src/terminal/terminal-webview-document-script.generated.ts',
  'src/terminal/terminal-webview-html.ts',
  'src/terminal/terminal-webview-html/document-shell.ts',
  'src/terminal/terminal-webview-html/document-close.ts'
]

const GAINED_OUTSIDE_THE_DOCUMENT = [
  'src/terminal/TerminalWebView.web.tsx',
  'src/terminal/terminal-web-document-mount.ts',
  'src/terminal/terminal-webview-engine-css.generated.ts',
  'src/terminal/terminal-webview-html.web.ts',
  'src/terminal/terminal-webview-html/document-markup.ts',
  'src/terminal/terminal-webview-html/document-style.ts',
  'src/terminal/terminal-webview-ready-promises.ts',
  'src/terminal/use-terminal-webview-controller.ts',
  // Scope rules to terminal host; shared rewrite also serves rich Markdown editor outside src/terminal.
  'src/style-scoping/document-style-scoping.ts'
]

const XTERM_PACKAGES = ['@xterm/xterm', '@xterm/addon-unicode11', '@xterm/addon-webgl']

const MERMAID_PAGE_ENGINE = 'src/components/pr-sidebar/mermaid-page-engine.generated.ts'
const MERMAID_PACKAGE = 'node_modules/mermaid/'

// Historical module totals are not budgets; compare actual closure membership below, with all mobile generators run before measuring.
/** What the page enters this route through once the route is a switch with a `.web.tsx` sibling. */
const ROUTE_ENTRY = [
  'app/h/[hostId]/session/[worktreeId].web.tsx',
  'src/session/MobileSessionRouteScreen.tsx'
]

const artifactModules = (inputs) => inputs.filter((input) => input.includes(MERMAID_PAGE_ENGINE))
const packageModules = (inputs) => inputs.filter((input) => input.includes(MERMAID_PACKAGE))

const bundles = mobileWebAppDependenciesPresent()
const describeClosure = bundles ? describe : describe.skip

describeClosure(
  "the session route's page closure with the terminal on it",
  () => {
    let closure
    beforeAll(async () => {
      closure = await mobileWebAppRouteClosure(SESSION_ROUTE)
    }, 300_000)

    it('gains the document, xterm and the addons, and sheds the engine string', async () => {
      const { local, modules } = closure
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
      // Require ordinary document modules, including message-bridge seams; generated program must not join closure.
      const documentModules = local.filter((module) => module.startsWith('src/terminal/document/'))
      expect(documentModules).toContain('src/terminal/document/create-terminal-document.ts')
      expect(documentModules).toContain('src/terminal/document/message-bridge.ts')
      // Generated bundle/entry belong to phone WebView; importing them into page duplicates document as modules and string.
      expect(documentModules).not.toContain('src/terminal/document/native-document-entry.ts')
      expect(local).not.toContain('src/terminal/terminal-webview-document-script.generated.ts')
    }, 300_000)

    it('enters through the web sibling and the route body, not the switch', async () => {
      const { local } = closure
      for (const entry of ROUTE_ENTRY) {
        expect(local, `${entry} is not in the closure`).toContain(entry)
      }
      // Native switch imports requireNativeViewManager; reaching it would throw when browser manifest loads route.
      expect(local).not.toContain('app/h/[hostId]/session/[worktreeId].tsx')
      expect(local).not.toContain('src/mobile-web-shell/MobileWebShellScreen.tsx')
    }, 300_000)

    it('reaches the engine as one deferred module and never as part of the download', async () => {
      const { modules } = closure
      expect(artifactModules(modules)).toHaveLength(1)
      // Exclude package sources already inside prebundled artifact; unrelated total counts are not boundary.
      expect(packageModules(modules)).toEqual([])

      const download = await mobileWebAppRouteChunkClosure(SESSION_ROUTE)
      // No static engine edge: opening session must not fetch Mermaid.
      expect(artifactModules(download.staticInputs)).toEqual([])
      // Require deferred artifact present; dropped engine would also satisfy static absence.
      expect(artifactModules(download.deferredInputs)).toHaveLength(1)
      // Require route chunk in walk so empty static download cannot pass.
      expect(download.staticChunks).toContain(download.routeChunk)
    }, 600_000)
  },
  900_000
)
