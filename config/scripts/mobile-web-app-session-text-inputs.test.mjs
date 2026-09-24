/**
 * Every text input the session screen reaches, and the size it declares.
 *
 * iOS zooms the page on focus of any input under 16px and does not zoom back out, so the document
 * spends the rest of that typing session at a scale other than 1 — which `keyboard-occlusion.web.ts`
 * reads as "not a keyboard" on purpose, because geometry cannot separate a zoom from a keyboard.
 *
 * This closure is the one that cannot afford it. The terminal's own input is a hidden field the
 * keyboard seam's geometry is the whole basis of, and this screen reaches nine inputs that declare
 * a size — a custom-key capture field, a prompt modal, the chat's ask/composer/question fields, the
 * quick-command editor and its search, and the terminal command bar. One of them left off the seam
 * leaves every later focus on this screen measuring a zoomed document.
 *
 * The rule is the closure rather than the nine sites it happens to have today: a module entering it
 * later is held to it without anyone remembering to add it here.
 */
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mobileWebAppRouteClosure } from './build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  TEXT_INPUT_FONT_SIZE_SEAM,
  textInputFontSizeOffenders,
  unresolvedTextInputStyles
} from './mobile-web-app-text-input-font-size-seam.mjs'

const mobileDir = fileURLToPath(new URL('../../mobile/', import.meta.url))
const describeClosure = mobileWebAppDependenciesPresent() ? describe : describe.skip

const SESSION = 'app/h/[hostId]/session/[worktreeId].tsx'

/**
 * The style module this screen splits, as the page bundle resolves it.
 *
 * Named rather than left to the offender list because a split is the one fix that can be undone
 * without reopening the offence: delete the `.web.ts` and the native sibling's size is what the
 * page runs, which is a 15px chat composer and a zoomed document, and the offender list would say
 * so — but only the next time someone reads it. Listed here, the closure says which file the page
 * loads.
 */
const SPLIT_WEB_STYLES = ['src/session/mobile-native-chat-input-styles.web.ts']

describeClosure(
  'the text inputs the session screen reaches',
  () => {
    it('takes every input size through the seam', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(textInputFontSizeOffenders(mobileDir, closure)).toEqual([])
    })

    it('reads every input it found, so the list above is complete', async () => {
      // The completeness half: an empty offender list is evidence only if every input was read.
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(unresolvedTextInputStyles(mobileDir, closure)).toEqual([])
    })

    it('carries the seam, so the rule is not vacuous', async () => {
      // Without this an empty offender list would also be what a closure reaching no text input at
      // all produces, and the census would pass against a page that has nothing to raise.
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(closure.local).toContain(TEXT_INPUT_FONT_SIZE_SEAM)
      expect(closure.local.length).toBeGreaterThan(900)
    })

    it('loads the web half of the split style module, not the native one', async () => {
      const closure = await mobileWebAppRouteClosure(SESSION)
      expect(closure.local).toEqual(expect.arrayContaining(SPLIT_WEB_STYLES))
      expect(
        closure.local.filter((file) =>
          SPLIT_WEB_STYLES.some((web) => file === web.replace('.web.ts', '.ts'))
        )
      ).toEqual([])
    })
  },
  240_000
)
