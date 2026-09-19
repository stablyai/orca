/**
 * What the source-control hub and the diff review page may reach for a URL.
 *
 * Inside the shell's WebView react-native-web's `Linking.openURL` calls
 * `window.open(url, '_blank', 'noopener')`, which both shells refuse — iOS returns nil from
 * `createWebViewWith`, Android false from `onCreateWindow` — and resolves whether or not anything
 * opened. A call site left on that path reports success into a tap that did nothing, which is the
 * one failure the `externalLink` grant exists to remove.
 *
 * Both routes reach the PR sidebar, and the sidebar is where this domain's openers are: a check's
 * "open on the web", a comment's permalink, and a link inside comment Markdown. So both are held
 * to the same rule and neither inherits it from the other.
 *
 * The rule, not the three call sites it happens to have today: a module entering either closure
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

const HUB = 'app/h/[hostId]/source-control/[worktreeId].tsx'
const REVIEW = 'app/h/[hostId]/review/[worktreeId].tsx'

/** The sidebar both routes render, and the reason each declares the grant on its own account. */
const PR_COMMENT_CARD = 'src/components/pr-sidebar/PRCommentCard.tsx'

describeClosure(
  'the source-control and review page closures',
  () => {
    it.each([HUB, REVIEW])('opens every external URL through the seam: %s', async (route) => {
      const closure = await mobileWebAppRouteClosure(route)
      expect(externalLinkOffenders(mobileDir, closure)).toEqual([])
    })

    it.each([HUB, REVIEW])('contains the seam, so the rule is not vacuous: %s', async (route) => {
      // Without this an empty offender list would also be what a closure reaching no link code at
      // all produces, and the census would pass against a page that opens nothing.
      const closure = await mobileWebAppRouteClosure(route)
      expect(closure.local).toContain(SEAM)
      expect(closure.local.length).toBeGreaterThan(400)
    })

    it('reaches the openers from the PR sidebar, which both routes render', async () => {
      // The reason the grant is each route's own rather than one inherited through a hop: without
      // this, `externalLink` on both would be a line in a manifest nothing holds to a caller.
      const [hub, review] = await Promise.all([
        mobileWebAppRouteClosure(HUB),
        mobileWebAppRouteClosure(REVIEW)
      ])
      expect(hub.local).toContain(PR_COMMENT_CARD)
      expect(review.local).toContain(PR_COMMENT_CARD)
    })
  },
  240_000
)
