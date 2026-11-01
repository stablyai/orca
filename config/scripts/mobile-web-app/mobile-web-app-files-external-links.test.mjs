// RN-Web Linking.openURL uses window.open, which shells refuse while reporting success; require device external-link seam.
// Preview consumes it through Markdown; explorer grants it because in-document preview inherits opener’s grants, not merely because shared layout reaches the seam.
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  EXTERNAL_LINK_SEAM as SEAM,
  externalLinkOffenders
} from './platform-seams/mobile-web-app-external-link-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const EXPLORER = 'app/h/[hostId]/files/[worktreeId].tsx'
const PREVIEW = 'app/h/[hostId]/files/preview/[worktreeId].tsx'

/** The seam's only in-domain consumer, and the reason the preview declares the grant itself. */
const MARKDOWN = 'src/components/MobileMarkdown.tsx'

describeClosure(
  'the files page closures',
  () => {
    it.each([EXPLORER, PREVIEW])('opens every external URL through the seam: %s', async (route) => {
      const closure = await mobileWebAppRouteClosure(route)
      expect(externalLinkOffenders(mobileDir, closure)).toEqual([])
    })

    it.each([EXPLORER, PREVIEW])(
      'contains the seam, so the rule is not vacuous: %s',
      async (route) => {
        const closure = await mobileWebAppRouteClosure(route)
        expect(closure.local).toContain(SEAM)
        expect(closure.local.length).toBeGreaterThan(250)
      }
    )

    it('reaches the seam from the Markdown preview, which is what earns the preview its grant', async () => {
      // Require preview’s own externalLink caller, not just an unexercised manifest declaration.
      const preview = await mobileWebAppRouteClosure(PREVIEW)
      const explorer = await mobileWebAppRouteClosure(EXPLORER)
      expect(preview.local).toContain(MARKDOWN)
      expect(explorer.local).not.toContain(MARKDOWN)
    })
  },
  240_000
)

// Preview copies Markdown via device seam; explorer grants clipboard because in-document preview inherits opening grants.
describeClosure(
  'the clipboard the files pages reach',
  () => {
    it.each([EXPLORER, PREVIEW])('never uses the page clipboard: %s', async (route) => {
      const closure = await mobileWebAppRouteClosure(route)
      expect(closure.modules.filter((file) => file.endsWith('ExpoClipboard.web.js'))).toEqual([])
    })

    it('reaches the device writer through the Markdown source Copy control', async () => {
      const preview = await mobileWebAppRouteClosure(PREVIEW)
      const explorer = await mobileWebAppRouteClosure(EXPLORER)
      expect(preview.local).toContain('src/components/MobileSourceCopyButton.tsx')
      expect(preview.local).toContain('src/platform/clipboard.web.ts')
      expect(explorer.local).not.toContain('src/platform/clipboard.web.ts')
    })
  },
  240_000
)
