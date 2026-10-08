import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppModuleClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'

/**
 * The 612 KiB xterm engine string, and where the page must never meet it.
 *
 * `terminal-webview-engine.generated.ts` is one minified IIFE of xterm plus two addons, built to
 * be injected into the WebView's HTML document as text. On the page the same engine arrives as an
 * import, so the string is 610 KiB of dead weight — the largest single module in the session
 * route's closure, and unusable there besides, because the shell's CSP has `script-src 'self'`
 * and no nested frame to load a document into.
 *
 * Nothing stops it entering: the module the document's `<style>` needs exported the engine string
 * beside it, so one import of the CSS would have pulled the whole thing in. The CSS is now its own
 * generated artifact and this is the fence. The document's modules are the entry set, because they
 * are what the page imports; the plant below is what says the walk would notice.
 */

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const mobileDir = join(projectDir, 'mobile')
const documentDir = join(mobileDir, 'src', 'terminal', 'document')

const ENGINE_MODULE = 'src/terminal/terminal-webview-engine.generated.ts'
const ENGINE_CSS_MODULE = 'src/terminal/terminal-webview-engine-css.generated.ts'

const bundles = mobileWebAppDependenciesPresent()
const describeClosure = bundles ? describe : describe.skip

/**
 * Every module the document is made of, as entry points.
 *
 * The document is one script whose modules run in a pinned order and mostly reach each other by
 * side effect, so no single one of them is the root of a graph that holds the rest. Naming all of
 * them is what makes "the engine string is in none of their closures" a claim about the document
 * rather than about whichever module happened to be picked.
 */
async function documentEntryPoints() {
  const names = (await readdir(documentDir))
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.includes('.test'))
    .sort()
  expect(names.length).toBeGreaterThan(30)
  return names.map((name) => `src/terminal/document/${name.replace(/\.ts$/, '')}`)
}

describeClosure(
  'the terminal engine string against the page',
  () => {
    it('is in no closure of the document modules the page imports', async () => {
      const { local } = await mobileWebAppModuleClosure(await documentEntryPoints())
      expect(local).not.toContain(ENGINE_MODULE)
      // The precondition: a walk that resolved nothing would also contain nothing.
      expect(local).toContain('src/terminal/document/document-scope.ts')
      expect(local).toContain('src/terminal/document/terminal-init.ts')
    }, 180_000)

    it('is in no closure of the page terminal component either', async () => {
      const { local } = await mobileWebAppModuleClosure(['src/terminal/TerminalWebView'])
      expect(local).not.toContain(ENGINE_MODULE)
      // The extensionless specifier is what the bundle ships, so this is the page's component and
      // its `.web.ts` half of the HTML — naming the `.tsx` would measure the WebView no browser
      // loads. Both are asserted, because the assertion above holds vacuously for the native pair.
      expect(local).toContain('src/terminal/TerminalWebView.web.tsx')
      expect(local).toContain('src/terminal/terminal-webview-html.web.ts')
      expect(local).toContain(ENGINE_CSS_MODULE)
      expect(local).not.toContain('src/terminal/terminal-webview-html.ts')
      // Ruling 24 put the bridge's two host facts behind seams and ruling 25 made the document
      // ordinary modules, so the page reaches every one of them, `message-bridge` included: what
      // keeps the shell's frames out is the transport the page passes, not an absent module.
      expect(local).toContain('src/terminal/document/message-bridge.ts')
      expect(local).toContain('src/terminal/document/create-terminal-document.ts')
      // The entry is the bundle's, and the bundle is the phone's: a page that reached it would be
      // shipping a second copy of the document as a string.
      expect(local).not.toContain('src/terminal/document/native-document-entry.ts')
      expect(local).not.toContain('src/terminal/terminal-webview-document-script.generated.ts')
    }, 180_000)

    it('is still what the native document reads its CSS beside', async () => {
      // The shell rather than `terminal-webview-html`, which now has a `.web.ts` sibling the walk
      // would resolve instead and so measure the page's half — the opposite of the claim. The
      // shell is the module that reads both generated ones, so the cases above cannot pass by the
      // CSS having quietly gone missing.
      const { local } = await mobileWebAppModuleClosure([
        'src/terminal/terminal-webview-html/document-shell'
      ])
      expect(local).toContain(ENGINE_MODULE)
      expect(local).toContain(ENGINE_CSS_MODULE)
    }, 180_000)

    it('would be reported if a document module imported it', async () => {
      // Planted in a scratch tree rather than under src/terminal/document, so nothing else in the
      // repository ever walks the plant and no other census has to know it exists.
      const scratch = await mkdtemp(join(tmpdir(), 'orca-c75-engine-closure-'))
      try {
        const planted = join(scratch, 'src', 'terminal', 'document')
        await mkdir(planted, { recursive: true })
        await writeFile(
          join(planted, 'planted.ts'),
          "import { XTERM_ENGINE_JS } from '../terminal-webview-engine.generated'\n" +
            'export const planted = XTERM_ENGINE_JS.length\n'
        )
        await mkdir(join(scratch, 'src', 'terminal'), { recursive: true })
        await writeFile(
          join(scratch, 'src', 'terminal', 'terminal-webview-engine.generated.ts'),
          "export const XTERM_ENGINE_JS = 'planted'\n"
        )
        const { local } = await mobileWebAppModuleClosure(['./src/terminal/document/planted'], {
          absWorkingDir: scratch
        })
        expect(local).toContain(ENGINE_MODULE)
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    }, 180_000)
  },
  600_000
)
