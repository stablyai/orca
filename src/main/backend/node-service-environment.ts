import type { AppEnvironment } from '../../shared/app-environment'
import type { BackendBootstrap } from '../../shared/backend-service-contract'

export function createDesktopBackendEnvironment(config: BackendBootstrap) {
  return createNodeServiceEnvironment({
    getPath(name) {
      if (name !== 'userData') {
        throw new Error(`Desktop backend path is unsupported: ${name}`)
      }
      return config.paths.userData
    },
    getAppPath: () => config.appPath,
    getVersion: () => config.build,
    isPackaged: () => config.isPackaged
  })
}

export function createNodeServiceEnvironment(
  host: Pick<
    AppEnvironment,
    'getPath' | 'getAppPath' | 'getVersion' | 'isPackaged' | 'getCliLauncherPath'
  >
): {
  environment: AppEnvironment
  runQuitHandlers(): void
} {
  const quitHandlers: (() => void)[] = []
  return {
    environment: {
      ...host,
      onWillQuit: (handler) => quitHandlers.push(handler),
      exit: (code = 0) => process.exit(code),
      getAppMetrics: () => []
    },
    runQuitHandlers() {
      const errors: unknown[] = []
      for (const handler of quitHandlers.splice(0)) {
        try {
          handler()
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) {
        throw new AggregateError(errors, 'backend_service_quit_handlers_failed')
      }
    }
  }
}
