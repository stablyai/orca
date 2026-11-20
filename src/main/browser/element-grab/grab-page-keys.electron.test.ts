import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import {
  buildPopupIdentityProbe,
  createPopupIdentityProbeRoot
} from '../electron-fixtures/popup-identity-electron-probe'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runElectronFixture } from '../electron-fixtures/electron-fixture-run'

const preloadRoot = createPopupIdentityProbeRoot()
afterAll(() => rmSync(preloadRoot, { recursive: true, force: true }))

describe('tool letters from a real page during a pick', () => {
  // Builds a fixture bundle and launches real Electron, which is slow on CI runners.
  it.each(['browser-guest', 'doc-preview-link'])(
    '%s: leaves typing to page fields (also in shadow roots) and takes letters only off them',
    async (preloadName) => {
      const runRoot = mkdtempSync(join(preloadRoot, 'run-'))
      mkdirSync(join(runRoot, 'home'), { recursive: true })
      await buildPopupIdentityProbe(
        runRoot,
        join(process.cwd(), `src/preload/${preloadName}.ts`),
        'browser-guest-preload.cjs'
      )
      const result = await runElectronFixture(
        join(import.meta.dirname, 'testing/grab-page-keys-electron-fixture.ts'),
        {
          ORCA_BROWSER_GUEST_PRELOAD: join(runRoot, 'browser-guest-preload.cjs'),
          HOME: join(runRoot, 'home'),
          XDG_CONFIG_HOME: join(runRoot, 'home', 'config')
        },
        { isolatedEnvironment: true }
      )
      for (const line of result.stderr
        .split('\n')
        .filter((line) => line.startsWith('[palette-proof]'))) {
        process.stdout.write(`${line}\n`)
      }
      expect(result.timedOut).toBe(false)
      expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
      expect(result.output).toEqual({
        focusAfterArm: 'search',
        searchValue: 'cd',
        forwardedWhileInField: [],
        tabThenLetter: { focused: 'host', forwarded: [] },
        scriptFocusThenLetter: { value: 'sa', forwarded: [] },
        noteValue: 'g',
        closedField: { value: 'd', forwarded: [] },
        forwardedOnButton: ['a', 'g', 'd'],
        offFieldBody: ['d'],
        pageSawToolKey: false,
        altEdges: ['alt-down', 'alt-up'],
        agentForwarded: [],
        chordOffField: { pages: ['page-1'], pageSawChord: false, copySeen: false },
        chordInField: { pages: [], pageSawChord: true },
        replacement: {
          oldKind: 'cancelled',
          newKind: 'selected',
          forwarded: ['g'],
          pageSawKey: false
        },
        afterCancellation: { kind: 'cancelled', forwarded: [], pageSawKey: true },
        retiredPolicy: { userKeyReachedPage: true, agentKeyReachedPage: true, forwarded: [] },
        nonCommit: { documentKept: true, pages: ['page-1'], pageSawChord: false },
        chordRefresh: {
          oldChord: { pages: [], pageSawKey: true },
          newChord: { pages: ['page-1'], pageSawKey: false },
          agentChord: { pages: [], pageSawKey: true }
        }
      })
    },
    60_000
  )
})
