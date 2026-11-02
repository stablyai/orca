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

/** Marks the browser commands that act on one page as taking `--page`. */
export function withBrowserPageTarget(specs: CommandSpec[]): CommandSpec[] {
  return specs.map((spec) =>
    NOT_PAGE_TARGETED.has(spec.path.join(' ')) ? spec : { ...spec, browserPageTarget: true }
  )
}
