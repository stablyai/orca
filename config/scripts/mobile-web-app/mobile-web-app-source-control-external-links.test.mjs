// Shells refuse RN-Web Linking/window.open while reporting success; require externalLink seam in both source-control/review closures.
// Each route independently reaches PR sidebar’s check/permalink/Markdown openers; census also covers future callers.
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

const HUB = 'app/h/[hostId]/source-control/[worktreeId].tsx'
const REVIEW = 'app/h/[hostId]/review/[worktreeId].tsx'

const PR_COMMENT_CARD = 'src/components/pr-sidebar/PRCommentCard.tsx'

const CLIPBOARD_SEAM = 'src/platform/clipboard.web.ts'

describeClosure(
  'the source-control and review page closures',
  () => {
    it.each([HUB, REVIEW])('opens every external URL through the seam: %s', async (route) => {
      const closure = await mobileWebAppRouteClosure(route)
      expect(externalLinkOffenders(mobileDir, closure)).toEqual([])
    })

    it.each([HUB, REVIEW])('contains the seam, so the rule is not vacuous: %s', async (route) => {
      // Require reachable link code before absence checks so empty closure cannot pass.
      const closure = await mobileWebAppRouteClosure(route)
      expect(closure.local).toContain(SEAM)
    })

    it('reaches the openers from the PR sidebar, which both routes render', async () => {
      // Require each route’s own caller; manifest grants alone do not prove actual sidebar usage.
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

// Exclude expo-clipboard throughout both closures: secure-context navigator.clipboard fails under iOS custom scheme.
// Refresh commands/review notes must use granted native.clipboard.write seam; module absence catches future imports.
describeClosure(
  'the clipboard the source-control and review pages reach',
  () => {
    it.each([HUB, REVIEW])(
      "does not carry expo-clipboard's web module at all: %s",
      async (route) => {
        const closure = await mobileWebAppRouteClosure(route)
        expect(closure.modules.filter((file) => file.endsWith('ExpoClipboard.web.js'))).toEqual([])
      }
    )

    it.each([HUB, REVIEW])(
      'carries the seam that replaced it, so the absence above is not vacuous: %s',
      async (route) => {
        // Require clipboard seam remains reachable; empty closure cannot prove native path excluded.
        const closure = await mobileWebAppRouteClosure(route)
        expect(closure.local).toContain(CLIPBOARD_SEAM)
      }
    )
  },
  240_000
)
