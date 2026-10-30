// Shells refuse RN-Web window.open while Linking reports success; require device external-link seam throughout tasks closure, including future callers.
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

describeClosure(
  'the tasks page closure',
  () => {
    it('opens every external URL through the platform seam', async () => {
      const closure = await mobileWebAppRouteClosure('app/h/[hostId]/tasks.tsx')
      // Judge imported binding: tasks’ Linking.openURL spelling is valid when Linking comes from seam-backed barrel.
      expect(externalLinkOffenders(mobileDir, closure)).toEqual([])
    })

    it('contains the seam, so the rule above is not vacuous', async () => {
      // Require reachable link code before absence checks so empty closure cannot pass.
      const closure = await mobileWebAppRouteClosure('app/h/[hostId]/tasks.tsx')
      expect(closure.local).toContain(SEAM)
    })
  },
  180_000
)

// Exclude expo-clipboard throughout closure: navigator.clipboard needs secure context absent under iOS custom scheme.
// Module absence catches future callers regardless of naming; device seam handles platform access.
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
      // Require clipboard seam remains reachable; empty closure cannot prove native path excluded.
      const closure = await mobileWebAppRouteClosure('app/h/[hostId]/tasks.tsx')
      expect(closure.local).toContain('src/platform/clipboard.web.ts')
    })
  },
  180_000
)
