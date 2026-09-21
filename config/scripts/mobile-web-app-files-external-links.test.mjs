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
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
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
 * The explorer declares at least what the preview does, because it can become the preview.
 *
 * Grants are resolved once, from the route the shell opened: `grantsForRoute` reads
 * `session.routePathname` and `init.grants.native` carries the answer for the life of that
 * session. The explorer's rows push to the preview, and because the preview is a page route the
 * handoff keeps that push inside the same document — no second `init`, no re-resolved grants. So a
 * preview reached that way runs under the explorer's grants, and anything the preview is granted
 * and the explorer is not is refused at the call site with nothing on screen to say so.
 *
 * Pinned as a superset rather than as equality: the explorer may legitimately need a grant the
 * preview does not.
 */
describe('the grants an in-page hop carries', () => {
  const grantsOf = (pathname) =>
    MOBILE_WEB_PAGE_ROUTES.find((route) => route.pathname === pathname)?.grants

  it('gives the explorer every grant the preview declares', () => {
    const explorer = grantsOf('/h/[hostId]/files/[worktreeId]')
    const preview = grantsOf('/h/[hostId]/files/preview/[worktreeId]')
    // Both declared, so a renamed route cannot turn this into a comparison of two undefineds.
    expect(explorer, 'the explorer is declared').toBeDefined()
    expect(preview, 'the preview is declared').toBeDefined()
    expect(preview.length, 'the preview declares something to inherit').toBeGreaterThan(0)
    expect(preview.filter((grant) => !explorer.includes(grant))).toEqual([])
  })
})

/**
 * Neither files page writes a clipboard, which is why neither is granted `native.clipboard.write`.
 *
 * The control is the tasks closure: it does carry the seam, so a probe that finds nothing here is
 * one that can find something when there is something to find.
 */
describeClosure(
  'the clipboard the files pages reach',
  () => {
    it.each([EXPLORER, PREVIEW])('carries no clipboard at all: %s', async (route) => {
      const closure = await mobileWebAppRouteClosure(route)
      expect(closure.modules.filter((file) => file.endsWith('ExpoClipboard.web.js'))).toEqual([])
      expect(closure.local).not.toContain('src/platform/clipboard.web.ts')
    })

    it('finds the clipboard seam on the route that is granted it', async () => {
      const tasks = await mobileWebAppRouteClosure('app/h/[hostId]/tasks.tsx')
      expect(tasks.local).toContain('src/platform/clipboard.web.ts')
    })
  },
  240_000
)
