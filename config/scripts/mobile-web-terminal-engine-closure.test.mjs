import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppModuleClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app/mobile-web-app-bundle-dependencies.mjs'

// Page imports xterm directly; WebView’s ~612KiB engine IIFE is unusable/dead weight under shipped CSP.
// Separate CSS artifact prevents style import pulling engine string into document closure; planted offender proves fence detects it.

const projectDir = fileURLToPath(new URL('../..', import.meta.url))
const mobileDir = join(projectDir, 'mobile')
const documentDir = join(mobileDir, 'src', 'terminal', 'document')

const ENGINE_MODULE = 'src/terminal/terminal-webview-engine.generated.ts'
const ENGINE_CSS_MODULE = 'src/terminal/terminal-webview-engine-css.generated.ts'

const bundles = mobileWebAppDependenciesPresent()
const describeClosure = bundles ? describe : describe.skip

// Use every document module as entry: pinned side-effect startup order means no single module imports all others.
async function documentEntryPoints() {
  const names = (await readdir(documentDir))
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => !name.includes('.test'))
    .sort()
  return names.map((name) => `src/terminal/document/${name.replace(/\.ts$/, '')}`)
}

describeClosure(
  'the terminal engine string against the page',
  () => {
    it('is in no closure of the document modules the page imports', async () => {
      const { local } = await mobileWebAppModuleClosure(await documentEntryPoints())
      expect(local).not.toContain(ENGINE_MODULE)
      // Require resolved modules before interpreting absence; empty walk would also contain no engine.
      expect(local).toContain('src/terminal/document/document-scope.ts')
      expect(local).toContain('src/terminal/document/terminal-init.ts')
    }, 180_000)

    it('is in no closure of the page terminal component either', async () => {
      const { local } = await mobileWebAppModuleClosure(['src/terminal/TerminalWebView'])
      expect(local).not.toContain(ENGINE_MODULE)
      // Use extensionless component/HTML imports and require web siblings; explicit native pair would pass absence vacuously.
      expect(local).toContain('src/terminal/TerminalWebView.web.tsx')
      expect(local).toContain('src/terminal/terminal-webview-html.web.ts')
      expect(local).toContain(ENGINE_CSS_MODULE)
      expect(local).not.toContain('src/terminal/terminal-webview-html.ts')
      // message-bridge belongs in ordinary page document; transport seams exclude shell frames, not missing module.
      expect(local).toContain('src/terminal/document/message-bridge.ts')
      expect(local).toContain('src/terminal/document/create-terminal-document.ts')
      // Generated entry/bundle belongs to phone WebView; page must not ship second document as string.
      expect(local).not.toContain('src/terminal/document/native-document-entry.ts')
      expect(local).not.toContain('src/terminal/terminal-webview-document-script.generated.ts')
    }, 180_000)

    it('is still what the native document reads its CSS beside', async () => {
      // Native shell, not web-resolved terminal-webview-html, proves both generated CSS/engine still exist for phone.
      const { local } = await mobileWebAppModuleClosure([
        'src/terminal/terminal-webview-html/document-shell'
      ])
      expect(local).toContain(ENGINE_MODULE)
      expect(local).toContain(ENGINE_CSS_MODULE)
    }, 180_000)

    it.each(['bare', 'relative', 'absolute'])(
      'would be reported if a document module imported it (%s entry)',
      async (entryKind) => {
        // Plant offender in scratch tree so other document censuses cannot observe test-only module.
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
          const entry = 'src/terminal/document/planted'
          const entryPoint =
            entryKind === 'absolute'
              ? join(scratch, 'src', 'terminal', 'document', 'planted')
              : entryKind === 'relative'
                ? `./${entry}`
                : entry
          const { local } = await mobileWebAppModuleClosure([entryPoint], {
            absWorkingDir: scratch
          })
          expect(local).toContain(ENGINE_MODULE)
        } finally {
          await rm(scratch, { recursive: true, force: true })
        }
      },
      180_000
    )
  },
  600_000
)
