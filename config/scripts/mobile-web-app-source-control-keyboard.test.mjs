/**
 * What the source-control hub and the diff review page measure a keyboard with.
 *
 * react-native-web's `Keyboard` is a stub: `addListener` returns a subscription that never fires
 * and `isVisible()` is always false. A module inside the page that waits for `keyboardDidShow`
 * waits for the life of the document, and the software keyboard covers whatever is at the bottom
 * of it — the hub's commit bar and the review note composer, both of which are text entry.
 *
 * So the rule is the seam, not the two call sites it has today: `platform/keyboard-occlusion` is
 * the one module in either closure allowed to name the stub, and it has a `.web.ts` sibling that
 * reads `visualViewport` instead.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const HUB = 'app/h/[hostId]/source-control/[worktreeId].tsx'
const REVIEW = 'app/h/[hostId]/review/[worktreeId].tsx'
const SEAM = 'src/platform/keyboard-occlusion.web.ts'

/**
 * The one module that subscribes to the stub and is not the seam, exempt by name.
 *
 * `mounted-bottom-drawer.tsx` reads more than a height: `Keyboard.metrics()` for a sheet opened
 * over an already-raised keyboard, and each event's `duration` to animate with it. The seam models
 * neither, and the drawer is in C1's, C2's, C3's and C5's closures as well as these two, so moving
 * it is a change to every page rather than to this domain. Its listeners are inert on the web the
 * same way, which is exactly why the composer inside it takes its own padding here.
 */
const SUBSCRIBES_TO_THE_STUB = ['src/components/mounted-bottom-drawer.tsx']

/**
 * The seam itself, which is the one place allowed to name the stub.
 *
 * The two files by name rather than everything under `src/platform/`: a later
 * `src/platform/<something>.web.ts` that subscribed to `Keyboard` directly would be the same
 * defect this census exists for, and a directory-wide exemption would wave it through.
 */
const SEAM_FILES = ['src/platform/keyboard-occlusion.ts', 'src/platform/keyboard-occlusion.web.ts']

/**
 * `rootDir` is a parameter for the planted case below, which must not write into the real tree:
 * `mobile-web-app-web-overrides.test.mjs` lists `mobile/src` in a parallel worker and would see a
 * planted file as an unlisted `.web.*` override. `findWebSiblings(rootDir)` takes a root for the
 * same reason.
 */
function keyboardSubscribers(closure, rootDir = mobileDir) {
  return closure.local
    .filter((file) => !SEAM_FILES.includes(file))
    .filter((file) => {
      try {
        return readFileSync(join(rootDir, file), 'utf8').includes('Keyboard.addListener')
      } catch {
        return false
      }
    })
    .sort()
}

describeClosure(
  'the keyboard the source-control and review pages measure',
  () => {
    it.each([HUB, REVIEW])('measures it through the seam and nowhere else: %s', async (route) => {
      const closure = await mobileWebAppRouteClosure(route)
      expect(keyboardSubscribers(closure)).toEqual(SUBSCRIBES_TO_THE_STUB)
    })

    it.each([HUB, REVIEW])('carries the seam, so the rule is not vacuous: %s', async (route) => {
      // Without this an empty subscriber list would also be what a closure reaching no keyboard
      // code at all produces, and the census would pass against a page that measures nothing.
      const closure = await mobileWebAppRouteClosure(route)
      expect(closure.local).toContain(SEAM)
    })

    it('names a module under src/platform that is not the seam', async () => {
      // The exemption is the two seam files, not their directory: a planted subscriber beside them
      // is named, which a `startsWith('src/platform/')` filter would have let through.
      //
      // Under mkdtemp rather than in `mobile/src/platform/`: the overrides census walks that tree
      // in a parallel worker, and a planted `.web.ts` there is an unlisted override to it.
      const root = mkdtempSync(join(tmpdir(), 'orca-keyboard-census-'))
      const subscriber =
        'import { Keyboard } from "react-native"\nKeyboard.addListener("x", () => {})\n'
      try {
        mkdirSync(join(root, 'src', 'platform'), { recursive: true })
        // The seam files carry the call too, so the empty result for them is the name exemption
        // doing the work rather than the two files happening not to subscribe.
        for (const file of ['src/platform/other.web.ts', ...SEAM_FILES]) {
          writeFileSync(join(root, file), subscriber)
        }
        expect(
          keyboardSubscribers({ local: ['src/platform/other.web.ts', ...SEAM_FILES] }, root)
        ).toEqual(['src/platform/other.web.ts'])
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('names an exemption that is really in both closures, so it cannot outlive its subject', async () => {
      const [hub, review] = await Promise.all([
        mobileWebAppRouteClosure(HUB),
        mobileWebAppRouteClosure(REVIEW)
      ])
      for (const file of SUBSCRIBES_TO_THE_STUB) {
        expect(hub.local, file).toContain(file)
        expect(review.local, file).toContain(file)
      }
    })
  },
  240_000
)
