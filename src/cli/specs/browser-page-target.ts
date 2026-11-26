import type { CommandSpec } from '../discovery/command-spec'

// These open, list or configure pages, so there is no one page to target.
const NOT_PAGE_TARGETED = new Set([
  'extension list',
  'extension reload',
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

// These report `effects` after a settle, which `--no-effects` skips. `eval`, dialogs and storage never settle.
const NO_EFFECTS_EXCLUDED = new Set([
  'dialog accept',
  'dialog dismiss',
  'eval',
  'storage local clear',
  'storage local set',
  'storage session clear',
  'storage session set'
])
const NO_EFFECTS_COMMANDS = new Set(
  [...EXPECT_URL_COMMANDS].filter((path) => !NO_EFFECTS_EXCLUDED.has(path))
)

/** Marks the browser commands that act on one page as taking `--page`, mutations `--expect-url`, and settling actions `--no-effects`. */
export function withBrowserPageTarget(specs: CommandSpec[]): CommandSpec[] {
  return specs.map((spec) => {
    const path = spec.path.join(' ')
    if (NOT_PAGE_TARGETED.has(path)) {
      return spec
    }
    const extraFlags = [
      ...(EXPECT_URL_COMMANDS.has(path) ? ['expect-url'] : []),
      ...(NO_EFFECTS_COMMANDS.has(path) ? ['no-effects'] : [])
    ]
    return {
      ...spec,
      browserPageTarget: true,
      ...(extraFlags.length > 0 ? { allowedFlags: [...spec.allowedFlags, ...extraFlags] } : {})
    }
  })
}
