import type { CommandSpec } from '../args'

// These open, list or configure pages, so there is no one page to target.
const NOT_PAGE_TARGETED = new Set([
  'open-url',
  'tab list',
  'tab current',
  'tab create',
  'tab profile list',
  'tab profile create',
  'tab profile delete',
  'browser identity get',
  'browser identity set'
])

// These change the page or its stored state and can check its URL first. `exec` stays out because
// one raw batch can navigate and retarget past any check; settings and tab commands name no resource.
const EXPECT_URL_COMMANDS = new Set([
  'back',
  'check',
  'clear',
  'click',
  'dblclick',
  'dialog accept',
  'dialog dismiss',
  'download',
  'drag',
  'eval',
  'fill',
  'find',
  'focus',
  'forward',
  'goto',
  'hover',
  'inserttext',
  'keypress',
  'mouse down',
  'mouse move',
  'mouse up',
  'mouse wheel',
  'reload',
  'scroll',
  'scrollintoview',
  'select',
  'select-all',
  'storage local clear',
  'storage local set',
  'storage session clear',
  'storage session set',
  'type',
  'uncheck',
  'upload'
])

/** Marks the browser commands that act on one page as taking `--page`, and mutations `--expect-url`. */
export function withBrowserPageTarget(specs: CommandSpec[]): CommandSpec[] {
  return specs.map((spec) => {
    const path = spec.path.join(' ')
    if (NOT_PAGE_TARGETED.has(path)) {
      return spec
    }
    return {
      ...spec,
      browserPageTarget: true,
      ...(EXPECT_URL_COMMANDS.has(path)
        ? { allowedFlags: [...spec.allowedFlags, 'expect-url'] }
        : {})
    }
  })
}
