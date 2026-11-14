import type { PageState } from './browser-client-host-command-state'
import { releaseBrowserClientPageInitialization } from './browser-client-host-command-page'
export async function joinBrowserClientHostCommands(
  handlers: Promise<void>[],
  timeoutMs: number
): Promise<boolean> {
  if (handlers.length === 0) {
    return true
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.allSettled(handlers).then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

export function retireBrowserClientCommandPage(
  page: PageState,
  joinTimeoutMs: number,
  cancel: () => void
): Promise<boolean> {
  if (page.retired) {
    return Promise.resolve(true)
  }
  if (page.retirementPromise) {
    return page.retirementPromise
  }
  const retirement = Promise.withResolvers<boolean>()
  page.retirementPromise = retirement.promise
  page.retiring = true
  cancel()
  void joinBrowserClientHostCommands(
    page.queue.flatMap((record) => (record.handlerPromise ? [record.handlerPromise] : [])),
    joinTimeoutMs
  ).then((settled) => {
    if (settled) {
      page.retiring = false
      page.retired = true
      releaseBrowserClientPageInitialization(page)
    } else if (page.retirementPromise === retirement.promise) {
      page.retirementPromise = undefined
    }
    retirement.resolve(settled)
  })
  return retirement.promise
}
