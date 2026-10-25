// Shells refuse RN-Web window.open while Linking reports success; require externalLink seam throughout session closure, including future callers.
// Terminal links and file/Markdown readers must open system browser without navigating artifact away.
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

const SESSION = 'app/h/[hostId]/session/[worktreeId].tsx'

const CLIPBOARD_SEAM = 'src/platform/clipboard.web.ts'

describeClosure(
  'the session screen closure',
  () => {
    it('opens every external URL through the platform seam', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(externalLinkOffenders(mobileDir, closure)).toEqual([])
    })

    it('contains the seam, so the rule above is not vacuous', async () => {
      // Require reachable link code before absence assertions; empty closure could otherwise pass.
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(closure.local).toContain(SEAM)
      expect(closure.local.length).toBeGreaterThan(900)
    })
  },
  240_000
)

// Exclude expo-clipboard throughout closure: it uses secure-context navigator.clipboard, unavailable under iOS custom scheme.
// All session clipboard reads/writes must use device seam; module absence catches future imports regardless of caller names.
describeClosure(
  'the clipboard the session screen reaches',
  () => {
    it("does not carry expo-clipboard's web module at all", async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(closure.modules.filter((file) => file.endsWith('ExpoClipboard.web.js'))).toEqual([])
    })

    it('carries the seam that replaced it, so the absence above is not vacuous', async () => {
      // Require clipboard seam remains reachable; empty closure cannot prove native path excluded.
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(closure.local).toContain(CLIPBOARD_SEAM)
    })
  },
  240_000
)
