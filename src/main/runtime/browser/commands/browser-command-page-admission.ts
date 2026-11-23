import type {
  BrowserCommandTargetParams,
  RuntimeBrowserCommandHost
} from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'
import type { RuntimeBrowserTabQueries } from '../tabs/browser-tab-queries'
import { BROWSER_COMMANDS_WITHOUT_PAGE_ADMISSION } from './browser-commands-without-page-admission'

type BrowserPageCommand = (
  params: BrowserCommandTargetParams & { index?: number },
  ...rest: unknown[]
) => unknown
function isBrowserPageCommand(value: unknown): value is BrowserPageCommand {
  return typeof value === 'function'
}

/** Wraps each page command so it runs once its page is admitted (or directly on a page this host renders). */
export function admitBrowserPageCommands(
  commands: object,
  {
    host,
    targets,
    queries
  }: {
    host: RuntimeBrowserCommandHost
    targets: RuntimeBrowserCommandTargets
    queries: RuntimeBrowserTabQueries
  }
): void {
  for (const [name, value] of Object.entries(commands)) {
    if (BROWSER_COMMANDS_WITHOUT_PAGE_ADMISSION.has(name)) {
      continue
    }
    if (!isBrowserPageCommand(value)) {
      continue
    }
    const command = value
    Reflect.set(
      commands,
      name,
      async (params: BrowserCommandTargetParams & { index?: number }, ...rest: unknown[]) => {
        const answer =
          name === 'browserDialogAccept' ||
          name === 'browserDialogDismiss' ||
          name === 'browserProceedCertificate'
        if (name === 'browserProceedCertificate' && !params.page) {
          return command.call(commands, params)
        }
        let target = params
        if (name === 'browserTabSwitch' && !params.page) {
          const listed = await queries.browserTabList(params)
          const page = listed.tabs[params.index ?? -1]?.browserPageId
          if (page) {
            target = { ...params, page }
          }
        }
        if (target.page && host.getRuntimeBrowserPageRegistry().getPage(target.page)) {
          return command.call(commands, target, ...(answer ? [] : rest))
        }
        return targets.withPageOperation(
          target,
          (admitted, admitAnswer) =>
            Promise.resolve(
              command.call(commands, { ...target, ...admitted }, ...(answer ? [admitAnswer] : rest))
            ),
          answer
            ? 'answer'
            : name === 'browserReload' || name === 'browserGoto'
              ? 'recover'
              : 'ordinary'
        )
      }
    )
  }
}
