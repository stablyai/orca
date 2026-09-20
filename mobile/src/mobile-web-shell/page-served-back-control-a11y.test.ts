import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  PRESSABLE_TAGS,
  readAttribute,
  spreadsProps,
  type Read
} from './pressable-control-source-reader'

/**
 * A Back control the page serves is reachable by name or not at all. Inside the shell there is no
 * native chrome behind it, so a bare Pressable is absent from the accessibility tree: a screen
 * reader has nothing to announce and an automation harness has nothing to find. The C2.7 device
 * proof located the tasks Back only by tapping the native control's coordinates.
 *
 * What makes a control a Back control here is what it does, not what it draws. A glyph does not
 * separate the two: dismisses sit in the same header slot with the same style, so keying on
 * ChevronLeft claims a dismiss and then tells it to be called Back, and lets a Back drawn any
 * other way walk past. So the predicate is the press handler reaching a back call, or a label that
 * already says Back; a control matching neither is outside this rule whatever it renders.
 *
 * The label half of that predicate would be circular on its own — a control with the wrong label
 * and an opaque handler would simply not be found — which is what the presence assertion below is
 * for: a screen that yields no control at all fails. One of the five depends on it today, the host
 * screen, whose `actions.leaveHost` is a member access this rule does not follow; the other four
 * are found behaviourally, the preview included, because the hook's `requestBack` is named for
 * what it does. The gap it leaves is a second Back control in a screen that already has one.
 */
const MOBILE_ROOT = join(import.meta.dirname, '..', '..')
const PAGE_ROUTE_REGISTRY = join(
  MOBILE_ROOT,
  '..',
  'config',
  'scripts',
  'mobile-web-page-routes.mjs'
)

/**
 * One entry per route in MOBILE_WEB_PAGE_ROUTES, naming the module that renders that route's Back.
 * The module rather than its directory, because two routes share `src/files`: asserting presence
 * per directory lets one of the pair answer for both, and the preview's Back could then be
 * rewritten into a Close with nothing going red.
 */
const PAGE_SERVED_SCREENS = [
  { pathname: '/h/[hostId]', screen: 'src/host-screen/host-screen-header.tsx' },
  {
    pathname: '/h/[hostId]/agent-history/[worktreeId]',
    screen: 'src/agent-history/MobileAgentSessionHistoryPanel.tsx'
  },
  { pathname: '/h/[hostId]/tasks', screen: 'src/tasks/mobile-tasks-screen-chrome.tsx' },
  { pathname: '/h/[hostId]/files/[worktreeId]', screen: 'src/files/MobileFileExplorerPanel.tsx' },
  {
    pathname: '/h/[hostId]/files/preview/[worktreeId]',
    screen: 'src/files/MobileFilePreviewScreen.tsx'
  }
]

/** The rule reads whole trees, so a Back added beside a screen is ruled as well as the screen's. */
const screenTree = (screen: string): string => screen.slice(0, screen.lastIndexOf('/'))

/** `router.back()`, `goBack()`, `onBack()`; the leading class keeps `callback(` and `rollback(` out. */
const BACK_CALL = /(?:^|[^A-Za-z0-9_$])(?:back|goBack|onBack)\s*\(/
const BACK_HANDLER = /^(?:back|[A-Za-z0-9_$]*Back)$/
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

type BackControl = { path: string; line: number; role: Read; label: Read }

function componentFiles(tree: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(join(MOBILE_ROOT, tree), { withFileTypes: true })) {
    const path = `${tree}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...componentFiles(path))
    } else if (entry.name.endsWith('.tsx') && !entry.name.includes('.test.')) {
      found.push(path)
    }
  }
  return found
}

/** One hop: `onPress={requestBack}` is read through the declaration `requestBack` names here. */
function declarationText(source: ts.SourceFile, name: string): string {
  let text = ''
  function visit(node: ts.Node): void {
    if (text) {
      return
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      text = node.getText(source)
      return
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      text = node.getText(source)
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return text
}

function pressGoesBack(source: ts.SourceFile, press: Read): boolean {
  if (!press.known) {
    return false
  }
  const text = press.value.trim()
  if (BACK_CALL.test(text)) {
    return true
  }
  if (!IDENTIFIER.test(text)) {
    return false
  }
  return BACK_HANDLER.test(text) || BACK_CALL.test(declarationText(source, text))
}

function backControlsIn(path: string): BackControl[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(join(MOBILE_ROOT, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const found: BackControl[] = []
  function visit(node: ts.Node): void {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const element = ts.isJsxElement(node) ? node.openingElement : node
      if (PRESSABLE_TAGS.has(element.tagName.getText())) {
        const label = readAttribute(element, 'accessibilityLabel')
        const named = label.known && /^Back\b/.test(label.value)
        if (
          spreadsProps(element) ||
          named ||
          pressGoesBack(source, readAttribute(element, 'onPress'))
        ) {
          found.push({
            path,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            role: readAttribute(element, 'accessibilityRole'),
            label
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

function backControlsUnder(tree: string): BackControl[] {
  return componentFiles(tree).flatMap((path) => backControlsIn(path))
}

function show(read: Read): string {
  if (!read.known) {
    return 'unknown'
  }
  return read.value || 'none'
}

function describeControl(control: BackControl): string {
  return `${control.path}:${control.line} role=${show(control.role)} label=${show(control.label)}`
}

function registeredPathnames(): string[] {
  return [...readFileSync(PAGE_ROUTE_REGISTRY, 'utf8').matchAll(/pathname: '([^']+)'/g)]
    .map((match) => match[1])
    .sort()
}

const SCREEN_TREES = [...new Set(PAGE_SERVED_SCREENS.map((entry) => screenTree(entry.screen)))]
const CONTROLS = SCREEN_TREES.flatMap((tree) => backControlsUnder(tree))

describe('Back controls in the screens the page serves', () => {
  it('covers every page route and finds a control in each, so the rules below cannot pass vacuously', () => {
    // A route listed in MOBILE_WEB_PAGE_ROUTES with no entry above is a screen this rule never
    // reads. The list grows in the PR that registers the route, as the flag census's does.
    expect(registeredPathnames()).toEqual(
      PAGE_SERVED_SCREENS.map((screen) => screen.pathname).sort()
    )
    expect(
      PAGE_SERVED_SCREENS.filter((entry) => backControlsIn(entry.screen).length === 0).map(
        (entry) => `${entry.pathname} -> ${entry.screen}`
      )
    ).toEqual([])
  })

  it('gives every one of them the button role', () => {
    expect(
      CONTROLS.filter((control) => !control.role.known || control.role.value !== 'button').map(
        describeControl
      )
    ).toEqual([])
  })

  it('names every one of them in the app’s own wording for Back', () => {
    expect(
      CONTROLS.filter(
        (control) => !control.label.known || !/^Back\b/.test(control.label.value)
      ).map(describeControl)
    ).toEqual([])
  })
})

/**
 * The trees a route not yet registered will bring under the rule, held to it before it does.
 *
 * `screenTree` takes a screen's directory, so registering the review route puts the whole of
 * `src/components` under these two rules and the source-control route puts `src/source-control`.
 * Fixing that in the PR that registers would make a route entry carry unrelated accessibility
 * work; fixing it here means C4.4 adds two rows to the table above and nothing else moves.
 *
 * This describe is what the rows replace: once they are in `PAGE_SERVED_SCREENS`, `CONTROLS`
 * covers these trees and the cases below become a second reading of the same thing.
 *
 * The modules, with their trees derived, for the reason the table above gives per screen: a tree
 * holds more than one Back, so presence asserted over the tree lets one answer for another.
 * `src/components` has two, and the review header's could have been renamed into a dismiss with
 * `CustomKeyModal`'s standing in for it.
 */
const ARRIVING_SCREENS = [
  'src/source-control/MobileSourceControlHeader.tsx',
  'src/components/MobileDiffReviewHeader.tsx'
]
const ARRIVING_TREES = [...new Set(ARRIVING_SCREENS.map(screenTree))]
const ARRIVING = ARRIVING_TREES.flatMap((tree) => backControlsUnder(tree))

describe('Back controls in the trees a registered route will add', () => {
  it('finds a control in each arriving screen, so the rules below cannot pass vacuously', () => {
    expect(ARRIVING_SCREENS.filter((screen) => backControlsIn(screen).length === 0)).toEqual([])
  })

  it('gives every one of them the button role', () => {
    expect(
      ARRIVING.filter((control) => !control.role.known || control.role.value !== 'button').map(
        describeControl
      )
    ).toEqual([])
  })

  it('names every one of them in the app’s own wording for Back', () => {
    expect(
      ARRIVING.filter(
        (control) => !control.label.known || !/^Back\b/.test(control.label.value)
      ).map(describeControl)
    ).toEqual([])
  })
})
