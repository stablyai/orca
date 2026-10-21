/**
 * What the session screen may reach for a URL, and whose clipboard it writes.
 *
 * Inside the shell's WebView react-native-web's `Linking.openURL` calls
 * `window.open(url, '_blank', 'noopener')`, which both shells refuse — iOS returns nil from
 * `createWebViewWith`, Android false from `onCreateWindow` — and resolves whether or not anything
 * opened. A call site left on that path reports success into a tap that did nothing, which is the
 * one failure the `externalLink` grant exists to remove.
 *
 * This screen's openers are a terminal link tap whose open mode is the phone's browser, and the two
 * WebView-backed readers it reaches through the file and Markdown panels, each of which sends a
 * tapped link to the system browser rather than navigating the artifact away.
 *
 * The rule, not the three call sites it happens to have today: a module entering this closure later
 * is held to it without anyone remembering to add it here.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  EXTERNAL_LINK_SEAM as SEAM,
  externalLinkOffenders
} from './mobile-web-app-external-link-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const SESSION = 'app/h/[hostId]/session/[worktreeId].tsx'

/** The clipboard seam, as the web build resolves it. */
const CLIPBOARD_SEAM = 'src/platform/clipboard.web.ts'

describeClosure(
  'the session screen closure',
  () => {
    it('opens every external URL through the platform seam', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(externalLinkOffenders(mobileDir, closure)).toEqual([])
    })

    it('contains the seam, so the rule above is not vacuous', async () => {
      // Without this an empty offender list would also be what a closure that reaches no link code
      // at all produces, and the census would pass against a page that opens nothing.
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(closure.local).toContain(SEAM)
      expect(closure.local.length).toBeGreaterThan(900)
    })
  },
  240_000
)

/**
 * The screen does not touch the clipboard through the browser's own.
 *
 * `expo-clipboard` resolves to `ExpoClipboard.web.js`, which is `navigator.clipboard`: it needs a
 * secure context, and the iOS shell serves the page from a custom scheme while Android serves
 * `https`, so that path works on one platform and silently not on the other. This screen is the
 * heaviest clipboard user in the app — a quick command's body, a diff note, a Markdown document, a
 * terminal selection, a structured send prompt, and the terminal's own paste — so all of it goes
 * through the seam and none of it through the browser.
 *
 * Asserted as the module's absence from the closure rather than as a count of importers: a new
 * import anywhere in the tree puts the file back, whoever writes it and whatever they name it.
 */
describeClosure(
  'the clipboard the session screen reaches',
  () => {
    it("does not carry expo-clipboard's web module at all", async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(closure.modules.filter((file) => file.endsWith('ExpoClipboard.web.js'))).toEqual([])
    })

    it('carries the seam that replaced it, so the absence above is not vacuous', async () => {
      // An empty list is also what a closure reaching no clipboard code at all would produce.
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(closure.local).toContain(CLIPBOARD_SEAM)
    })
  },
  240_000
)
