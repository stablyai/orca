import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { censusSourceFiles } from '../test-support/census-source-files'

/**
 * The hybrid shell flag is the whole of what keeps this feature dark in a native build, so who
 * touches it is a product invariant rather than a convention. A second reader is how a dark feature
 * stops being dark: a launch-time sweep, a prefetch or a menu item that consults the flag would run
 * in a native store build the moment anything flipped it, and none of those would fail a type
 * check.
 *
 * The build-kind fact is the same shape of invariant one level up. `EXPO_PUBLIC_MOBILE_SHELL` is
 * what a release workflow sets to build the OTA binary, and a second module spelling it would be a
 * second answer to "is this the page's build" that no type check would catch either.
 */
const MOBILE_ROOT = join(import.meta.dirname, '..', '..')
const FLAG_KEY = 'orca:mobileWebShellEnabled'
/** The inlined form. Prose may name the variable; this is the spelling that reads it. */
const BUILD_SWITCH_READ = 'process.env.EXPO_PUBLIC_'
/** The other spelling Expo's plugin inlines, which is how the rule above would be evaded. */
const BUILD_SWITCH_BRACKET_READ = "process.env['EXPO_PUBLIC_"
const DEFINITION = 'src/storage/preferences.ts'
/** The one product reader, which only the shared switch decision asks. */
const FLAG_HOOK = 'src/mobile-web-shell/use-mobile-web-shell-enabled.ts'
/** The one caller of that hook: every route asks this instead, so its list is the whole census. */
const DECISION = 'src/mobile-web-shell/shell-switch-decision.ts'
const ROUTE = 'app/h/[hostId]/web.tsx'
const HOST_ROUTE = 'app/h/[hostId]/index.tsx'
const AGENT_HISTORY_ROUTE = 'app/h/[hostId]/agent-history/[worktreeId].tsx'
const TASKS_ROUTE = 'app/h/[hostId]/tasks.tsx'
const FILES_ROUTE = 'app/h/[hostId]/files/[worktreeId].tsx'
const FILES_PREVIEW_ROUTE = 'app/h/[hostId]/files/preview/[worktreeId].tsx'
const SOURCE_CONTROL_ROUTE = 'app/h/[hostId]/source-control/[worktreeId].tsx'
const REVIEW_ROUTE = 'app/h/[hostId]/review/[worktreeId].tsx'
const SESSION_ROUTE = 'app/h/[hostId]/session/[worktreeId].tsx'
/** The one switch with no native screen behind it; its route file only re-exports this body. */
const CATCH_ALL_ROUTE = 'src/mobile-web-shell/catch-all-page-route.tsx'
/** What a switch paints while the decision is `pending`, and the third thing every switch names. */
const PENDING_SCREEN = 'src/mobile-web-shell/ShellSwitchPendingScreen.tsx'
/** One entry per screen the flag can switch to the page, which is what a review reads. */
const SWITCHED_ROUTES = [
  HOST_ROUTE,
  AGENT_HISTORY_ROUTE,
  TASKS_ROUTE,
  FILES_ROUTE,
  FILES_PREVIEW_ROUTE,
  SOURCE_CONTROL_ROUTE,
  REVIEW_ROUTE,
  SESSION_ROUTE,
  CATCH_ALL_ROUTE
]
const DEVELOPER_ROW = 'src/diagnostics/mobile-web-shell-dev-row.tsx'
/** The one screen that decides whether that row mounts, which is a build-kind question. */
const TROUBLESHOOT_ROUTE = 'app/troubleshoot.tsx'
/** Every tree that ships in the app bundle, with the floor each must clear. `modules` is two files,
 *  but it is where the native view lives and so the easiest place for a second reader to hide. */
const TREES = { src: 200, app: 10, modules: 1 }
const SHELL_VIEW = 'modules/orca-mobile-web-shell/src/index.ts'

function sourceFiles(directory: string): string[] {
  return censusSourceFiles(join(MOBILE_ROOT, directory))
    .map((path) => relative(MOBILE_ROOT, path))
    .filter((path) => /\.tsx?$/.test(path) && !path.includes('.test.'))
}

const SOURCES = Object.keys(TREES)
  .flatMap((tree) => sourceFiles(tree))
  .map((path) => ({
    path: path.split('\\').join('/'),
    text: readFileSync(join(MOBILE_ROOT, path), 'utf8')
  }))

function filesContaining(needle: string): string[] {
  return SOURCES.filter((file) => file.text.includes(needle))
    .map((file) => file.path)
    .sort()
}

/**
 * The same matches with the line each was read off, as the failure message for the rules below.
 *
 * A census that answers only with paths tells a reader which file is wrong and nothing about what
 * in it is: the needles here are identifiers, and a file can name one in an import, a call or a
 * comment. The snippet is what turns "this list moved" into the edit that moved it.
 */
function matchesOf(needle: string): string {
  // Sorted by path then by line number, not as text: `:59:` sorts before `:4:` as a string, which
  // reads as a file whose matches are out of order.
  return [...SOURCES]
    .sort((left, right) => left.path.localeCompare(right.path))
    .flatMap((file) =>
      file.text
        .split('\n')
        .flatMap((line, index) =>
          line.includes(needle) ? [`${file.path}:${index + 1}: ${line.trim()}`] : []
        )
    )
    .join('\n')
}

describe('who touches the hybrid shell flag', () => {
  it('reaches every shipped tree, so the absence assertions below cannot pass vacuously', () => {
    const paths = SOURCES.map((file) => file.path)
    expect(paths).toContain(DEFINITION)
    expect(paths).toContain(FLAG_HOOK)
    expect(paths).toContain(DECISION)
    expect(paths).toContain(PENDING_SCREEN)
    expect(paths).toContain(ROUTE)
    for (const route of SWITCHED_ROUTES) {
      expect(paths).toContain(route)
    }
    expect(paths).toContain(DEVELOPER_ROW)
    expect(paths).toContain(TROUBLESHOOT_ROUTE)
    expect(paths).toContain(SHELL_VIEW)
    const trees = Object.keys(TREES)
    for (const [tree, floor] of Object.entries(TREES)) {
      expect(paths.filter((path) => path.startsWith(`${tree}/`)).length).toBeGreaterThan(floor)
    }
    expect(paths.filter((path) => !trees.some((tree) => path.startsWith(`${tree}/`)))).toEqual([])
  })

  it('keeps the storage key itself in one module', () => {
    expect(filesContaining(FLAG_KEY)).toEqual([DEFINITION])
  })

  it('reads the build-time switch in one module', () => {
    // `babel-preset-expo` inlines an `EXPO_PUBLIC_*` variable only where it is spelled as a
    // literal member expression of `process.env`, so a second read is a second literal to keep in
    // step with the workflow input — and a value copied out into a binding is not rewritten at
    // all, which reads `undefined` on a device and answers native in a build that is not.
    //
    // Prose is not a read: the docblocks that name the variable are how a reader finds this
    // module, and pinning them would make every wording change a census failure.
    expect(filesContaining(BUILD_SWITCH_READ), matchesOf(BUILD_SWITCH_READ)).toEqual([DEFINITION])
    expect(
      filesContaining(BUILD_SWITCH_BRACKET_READ),
      matchesOf(BUILD_SWITCH_BRACKET_READ)
    ).toEqual([])
  })

  it('answers the build kind through one named function, asked by the flag and the row label', () => {
    expect(filesContaining('mobileShellBuildKind'), matchesOf('mobileShellBuildKind')).toEqual(
      [DEFINITION, DEVELOPER_ROW].sort()
    )
  })

  it('is read by one hook and by the developer row that writes it, and nowhere else', () => {
    expect(filesContaining('loadMobileWebShellEnabled')).toEqual(
      [DEFINITION, DEVELOPER_ROW, FLAG_HOOK].sort()
    )
  })

  it('is read by the shared switch decision and by nothing else', () => {
    // The narrowest this has ever been, and the reason the rule below is total: a route cannot
    // hold a private opinion about the flag — including about the window where it is still `null`
    // — without reading it, and this is the only place that reads it.
    expect(
      filesContaining('useMobileWebShellEnabled'),
      matchesOf('useMobileWebShellEnabled')
    ).toEqual([DECISION, FLAG_HOOK].sort())
  })

  it('reaches the switched routes through that decision and no others', () => {
    // Each switched route is a screen the flag decides the renderer of, and one more is one more
    // place a dark feature could turn itself on. The list grows once per domain series, in the PR
    // that switches the route file to MobileWebShellScreen, and never as a side effect of anything
    // else. A switched route is inert until MOBILE_WEB_PAGE_ROUTES lists it as well, so an entry
    // here can land a PR ahead of that one.
    expect(filesContaining('useShellSwitchDecision'), matchesOf('useShellSwitchDecision')).toEqual(
      [DECISION, ROUTE, ...SWITCHED_ROUTES].sort()
    )
  })

  it('gives every one of them the same neutral state to paint while the flag is unresolved', () => {
    // The rule a sixth switch would otherwise regress past. Reading the flag through the decision
    // is not on its own enough: a switch that ignored `pending` and fell through to its native
    // screen would satisfy the rule above and still flash native in front of a flag-on user. This
    // one says every switch names the neutral screen, which is existence rather than shape — where
    // it names it is the route test's business, and `shell-switch-null-flag.test.tsx` drives all
    // nine through the states themselves.
    expect(
      filesContaining('ShellSwitchPendingScreen'),
      matchesOf('ShellSwitchPendingScreen')
    ).toEqual([PENDING_SCREEN, ROUTE, ...SWITCHED_ROUTES].sort())
  })

  it('fences the build kind in one place, which the read, the hook and the row gate ask', () => {
    // The test that makes a native store build unable to turn the flag on: `__DEV__`, or a binary
    // built with the switch set to `ota`. The hook starts its state on it so a native release
    // build never reaches the neutral state, which is the same answer `loadMobileWebShellEnabled`
    // gives one render later — and two spellings of one build-kind test are two things to keep
    // true, where this feature's darkness rests on exactly one.
    //
    // The Troubleshoot route asks the same question to decide whether to mount the toggle, which
    // is the one place a user can switch an OTA build back to the native screens. Asking it rather
    // than re-deriving it is why that row and the flag can never disagree about the build.
    expect(
      filesContaining('mobileWebShellFlagCanBeOn'),
      matchesOf('mobileWebShellFlagCanBeOn')
    ).toEqual([DEFINITION, FLAG_HOOK, TROUBLESHOOT_ROUTE].sort())
  })

  it('is written only by the developer row', () => {
    expect(filesContaining('saveMobileWebShellEnabled')).toEqual([DEFINITION, DEVELOPER_ROW].sort())
  })
})
