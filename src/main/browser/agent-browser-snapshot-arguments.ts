import type { BrowserSnapshotOptions } from '../../shared/runtime-types'

export function agentBrowserSnapshotArgs(options: BrowserSnapshotOptions): string[] {
  const args = ['snapshot']
  if (options.interactive) {
    args.push('-i')
  }
  if (options.compact) {
    args.push('-c')
  }
  if (options.depth !== undefined) {
    args.push('-d', String(options.depth))
  }
  if (options.selector) {
    args.push('-s', options.selector)
  }
  if (options.urls) {
    args.push('-u')
  }
  if (options.delta) {
    args.push('--delta')
  }
  if (options.full) {
    args.push('--full')
  }
  return args
}
