/**
 * What the two files pages may reach for a URL and for the clipboard, which is what their grants
 * are declared against.
 *
 * Inside the shell's WebView react-native-web's `Linking.openURL` calls `window.open(url, '_blank')`,
 * which both shells refuse and which resolves whether or not anything opened, so a call site left on
 * that path reports success into a tap that did nothing.
 *
 * The two routes are declared with different grants, and this file is where that difference is
 * held to something: the preview renders Markdown, so it reaches the seam through `MobileMarkdown`
 * and is granted `externalLink`; the explorer reaches it only through the protocol wall in the
 * shared host layout, which every page route reaches and which the worktree list is granted
 * nothing for either.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  EXTERNAL_LINK_SEAM as SEAM,
  reachesReactNativeLinking
} from './mobile-web-app-external-link-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const EXPLORER = 'app/h/[hostId]/files/[worktreeId].tsx'
const PREVIEW = 'app/h/[hostId]/files/preview/[worktreeId].tsx'

/** The seam's only in-domain consumer, and the reason the preview's grant list is longer. */
const MARKDOWN = 'src/components/MobileMarkdown.tsx'

function offenders(closure) {
  return closure.local
    .filter((file) => file !== SEAM)
    .filter((file) => {
      try {
        return reachesReactNativeLinking(readFileSync(join(mobileDir, file), 'utf8'))
      } catch {
        return false
      }
    })
    .sort()
}

describeClosure(
  'the files page closures',
  () => {
    it.each([EXPLORER, PREVIEW])('opens every external URL through the seam: %s', async (route) => {
      const closure = await mobileWebAppRouteClosure(route)
      expect(offenders(closure)).toEqual([])
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
