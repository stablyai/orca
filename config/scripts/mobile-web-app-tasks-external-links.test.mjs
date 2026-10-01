/**
 * Nothing the tasks page reaches opens a URL through react-native, or a clipboard through the
 * browser's.
 *
 * Inside the shell's WebView react-native-web's `Linking.openURL` calls
 * `window.open(url, '_blank')`, which both shells refuse — iOS returns nil from
 * `createWebViewWith`, Android false from `onCreateWindow` — and resolves whether or not anything
 * opened. So a call site left on that path reports success into a tap that did nothing, which is
 * the one failure the `externalLink` grant exists to remove.
 *
 * The rule, not the twelve call sites it happens to have today: a module entering this closure
 * later is held to it without anyone remembering to add it here.
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

describeClosure(
  'the tasks page closure',
  () => {
    it('opens every external URL through the platform seam', async () => {
      const closure = await mobileWebAppRouteClosure('app/h/[hostId]/tasks.tsx')
      // Which module the name comes from, not which text a call site writes: the tasks tree
      // still calls `Linking.openURL`, and that `Linking` is the barrel's seam-backed export.
      expect(externalLinkOffenders(mobileDir, closure)).toEqual([])
    })

    it('contains the seam, so the rule above is not vacuous', async () => {
      // Without this an empty offender list would also be what a closure that reaches no link code
      // at all produces, and the census would pass against a page that opens nothing.
      const closure = await mobileWebAppRouteClosure('app/h/[hostId]/tasks.tsx')
      expect(closure.local).toContain(SEAM)
      expect(closure.local.length).toBeGreaterThan(400)
    })
  },
  180_000
)

/**
 * Nothing the tasks page reaches writes the clipboard through the browser's own.
 *
 * `expo-clipboard` resolves to `ExpoClipboard.web.js`, which is `navigator.clipboard`: it needs a
 * secure context, and the iOS shell serves the page from a custom scheme while Android serves
 * `https`, so that path works on one platform and silently not on the other. The verb exists so
 * neither has to be guessed at a call site.
 *
 * Asserted as the module's absence from the closure rather than as a count of importers: a new
 * import anywhere in the tree puts the file back, whoever writes it and whatever they name it.
 */
describeClosure(
  'the clipboard the tasks page reaches',
  () => {
    it("does not carry expo-clipboard's web module at all", async () => {
      const closure = await mobileWebAppRouteClosure('app/h/[hostId]/tasks.tsx')
      const browserClipboard = closure.modules.filter((file) =>
        file.endsWith('ExpoClipboard.web.js')
      )
      expect(browserClipboard).toEqual([])
    })

    it('carries the seam that replaced it, so the absence above is not vacuous', async () => {
      // An empty list is also what a closure reaching no clipboard code at all would produce.
      const closure = await mobileWebAppRouteClosure('app/h/[hostId]/tasks.tsx')
      expect(closure.local).toContain('src/platform/clipboard.web.ts')
    })
  },
  180_000
)
