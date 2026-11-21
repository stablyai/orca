import { BrowserRoutePageAvailability } from '../../../browser/routing/guest-authority/browser-route-page-availability'
import { BrowserClientPageCommandExecutor } from '../../../browser/client-pages/execution/browser-client-page-command-executor'
import { createHarness } from '../../../browser/client-pages/execution/browser-client-page-command-executor-test-harness'
import { BrowserClientHostCommandDispatcher } from '../../../browser/client-hosts/commands/browser-client-host-command-dispatcher'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'

export function createRecoveryNativeLoop(hooks: { failCommit?: boolean }) {
  const native = createHarness()
  const initializedUrls: string[] = []
  const availability = new BrowserRoutePageAvailability()
  const commits = new Map<string, ReturnType<typeof Promise.withResolvers<string>>>()
  const navigations = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const retirements = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const mounts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const mounting = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const retiring = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  function createExecutor() {
    return new BrowserClientPageCommandExecutor({
      ...native.dependencies,
      routeWebContents: {
        ...native.dependencies.routeWebContents,
        watchPageAvailability: availability.watch,
        navigateGuest: async (_claim, url) => {
          const id = new URL(url).pathname.slice(1)
          navigations.get(id)?.resolve()
          await commits.get(id)?.promise
          return true
        },
        initializeGuest: (_claim, url, signal) => {
          initializedUrls.push(url)
          if (hooks.failCommit) {
            return Promise.reject(new Error('precommit-failure'))
          }
          const id = new URL(url).pathname.slice(1)
          navigations.get(id)?.resolve()
          const commit = commits.get(id)
          if (!commit) {
            return Promise.resolve(url)
          }
          return new Promise<string>((resolve, reject) => {
            const abort = () => reject(new Error('cancelled'))
            signal.addEventListener('abort', abort, { once: true })
            void commit.promise.then(
              (value) => {
                signal.removeEventListener('abort', abort)
                resolve(value)
              },
              (error) => {
                signal.removeEventListener('abort', abort)
                reject(error)
              }
            )
            if (signal.aborted) {
              abort()
            }
          })
        }
      },
      selectRenderer: () => ({
        ...native.renderer,
        mountPage: async (input) => {
          mounting.get(input.browserPageId)?.resolve()
          await mounts.get(input.browserPageId)?.promise
          return native.renderer.mountPage()
        },
        retirePage: async (input) => {
          retiring.get(input.browserPageId)?.resolve()
          await retirements.get(input.browserPageId)?.promise
          await native.renderer.retirePage()
        }
      })
    })
  }
  return {
    native,
    initializedUrls,
    createExecutor,
    lose(id: string) {
      const registration =
        native.dependencies.routeWebContents.claimGuestLifecycle.mock.calls.findLast(
          ([registration]) => registration.browserPageId === id
        )?.[0]
      if (!registration) {
        throw new Error('Missing native page')
      }
      availability.report(registration)
    },
    hold(id: string) {
      commits.set(id, Promise.withResolvers<string>())
      const started = Promise.withResolvers<void>()
      navigations.set(id, started)
      return started.promise
    },
    release(id: string, url = `https://example.internal/${id}`) {
      commits.get(id)?.resolve(url)
      commits.delete(id)
    },
    holdRetirement(id: string) {
      const done = Promise.withResolvers<void>()
      retirements.set(id, done)
      const started = Promise.withResolvers<void>()
      retiring.set(id, started)
      return { started: started.promise, release: () => done.resolve() }
    },
    holdMount(id: string) {
      const done = Promise.withResolvers<void>()
      mounts.set(id, done)
      const started = Promise.withResolvers<void>()
      mounting.set(id, started)
      return { started: started.promise, release: () => done.resolve() }
    },
    releaseAll() {
      for (const done of mounts.values()) {
        done.resolve()
      }
      for (const done of retirements.values()) {
        done.resolve()
      }
      for (const done of commits.values()) {
        done.resolve('about:blank')
      }
    }
  }
}

export async function seedRecoveryNativePages(
  executor: BrowserClientPageCommandExecutor,
  ids: readonly string[],
  browserHostClientId: string,
  browserProfileId = 'profile-a',
  controlled = false
) {
  const oldAuthority = {
    authorityRuntimeId: 'runtime-old',
    authorityEpoch: 'epoch-old',
    browserHostClientId,
    browserHostGeneration: 1,
    pageCommandProtocolVersion: 1 as const,
    pageReconciliationProtocolVersion: 1 as const
  }
  const predecessor = new BrowserClientHostCommandDispatcher({
    authority: oldAuthority,
    handler: (event, signal) => executor.handle(event, signal)
  })
  for (const [index, id] of ids.entries()) {
    const event: BrowserClientHostCommandEvent = {
      ...oldAuthority,
      type: 'command',
      browserPageId: id,
      pageHostGeneration: index + 1,
      commandId: `seed-${id}`,
      commandSequence: 1,
      command: {
        type: 'createPage',
        ...(controlled ? { initialUrl: `https://example.internal/${id}` } : {}),
        browserProfileId,
        executionHostKey: 'execution-host-a',
        workspaceId: 'repo-1::/tmp/worktree-a'
      }
    }
    const result = await predecessor.dispatch(event)
    if (result.status !== 'completed') {
      throw new Error('predecessor-create-failed')
    }
    if (controlled) {
      const committed = await predecessor.dispatch({
        ...event,
        commandId: `seed-commit-${id}`,
        commandSequence: 2,
        command: { type: 'navigate', url: `https://example.internal/${id}` }
      })
      if (committed.status !== 'completed') {
        throw new Error('predecessor-commit-failed')
      }
    }
    executor.recordPublishedPageUrl({
      ...event,
      revision: 1,
      url: `https://example.internal/${id}`,
      title: 'Saved',
      loading: false,
      canGoBack: false,
      canGoForward: false
    })
  }
  await predecessor.close()
}
