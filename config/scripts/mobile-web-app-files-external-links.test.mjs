/**
 * What the two files pages may reach for a URL and for the clipboard, which is what their grants
 * are declared against.
 *
 * Inside the shell's WebView react-native-web's `Linking.openURL` calls `window.open(url, '_blank')`,
 * which both shells refuse and which resolves whether or not anything opened, so a call site left on
 * that path reports success into a tap that did nothing.
 *
 * Both routes declare `externalLink`, for different reasons, and this file holds each to its own.
 * The preview renders Markdown and reaches the seam through `MobileMarkdown`, a consumer inside the
 * domain. The explorer has no such consumer — its only reach is the shared host layout, which every
 * page route reaches and which the worktree list declares nothing for — and declares the grant
 * because its rows push to the preview in-page, under the session the explorer opened.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'
import {
  EXTERNAL_LINK_SEAM as SEAM,
  externalLinkOffenders
} from './mobile-web-app-external-link-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
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
      // The grant difference between the two routes, asserted rather than asserted-about: without
      // this the preview's `externalLink` would be a line in a manifest nothing holds to a caller.
      const preview = await mobileWebAppRouteClosure(PREVIEW)
      const explorer = await mobileWebAppRouteClosure(EXPLORER)
      expect(preview.local).toContain(MARKDOWN)
      expect(explorer.local).not.toContain(MARKDOWN)
    })
  },
  240_000
)

/**
 * The preview copies loaded Markdown through the device seam. The explorer grants it too because
 * an in-document preview keeps the explorer's opening grants.
 */
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

    it.each(['/h/[hostId]/files/[worktreeId]', '/h/[hostId]/files/preview/[worktreeId]'])(
      'grants the device writer when the document opens on %s',
      (pathname) => {
        const route = MOBILE_WEB_PAGE_ROUTES.find((entry) => entry.pathname === pathname)
        expect(route?.grants).toContain('native.clipboard.write')
      }
    )
  },
  240_000
)
