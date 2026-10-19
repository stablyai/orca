/** Source-control and review routes include the web keyboard seam. */
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'

const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const HUB = 'app/h/[hostId]/source-control/[worktreeId].tsx'
const REVIEW = 'app/h/[hostId]/review/[worktreeId].tsx'
const SEAM = 'src/platform/keyboard-occlusion.web.ts'

describeClosure(
  'keyboard seam in source-control and review route closures',
  () => {
    it.each([HUB, REVIEW])('includes the web keyboard seam: %s', async (route) => {
      const closure = await mobileWebAppRouteClosure(route)
      expect(closure.local).toContain(SEAM)
    })
  },
  240_000
)
