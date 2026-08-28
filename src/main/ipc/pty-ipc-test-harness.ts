import { createPtyIpcSuiteEnvironment } from './pty-ipc-suite-environment'
import { createPtyIpcProviderFixtures } from './pty-ipc-provider-fixtures'
import { createPtyIpcListenerAccessors } from './pty-ipc-listener-accessors'
import { createPtyIpcSpawnDrivers } from './pty-ipc-spawn-drivers'

/** Everything a split pty IPC suite file gets from one `setupPtyIpcSuite()` call. */
export type PtyIpcSuiteFixtures = ReturnType<typeof createPtyIpcSuiteEnvironment> &
  ReturnType<typeof createPtyIpcProviderFixtures> &
  ReturnType<typeof createPtyIpcListenerAccessors> &
  ReturnType<typeof createPtyIpcSpawnDrivers>

/**
 * One call per split pty IPC suite file: registers the shared hooks and hands back every
 * fixture the moved test bodies reference by bare name.
 */
export function setupPtyIpcSuite(): PtyIpcSuiteFixtures {
  const environment = createPtyIpcSuiteEnvironment()
  const providers = createPtyIpcProviderFixtures({ mainWindow: environment.mainWindow })
  const listeners = createPtyIpcListenerAccessors({
    handlers: environment.handlers,
    mainWindow: environment.mainWindow as never,
    mainWindowIpcEvent: environment.mainWindowIpcEvent
  })
  const spawns = createPtyIpcSpawnDrivers({
    handlers: environment.handlers,
    mainWindow: environment.mainWindow,
    createMockProc: providers.createMockProc as never
  })
  return { ...environment, ...providers, ...listeners, ...spawns }
}
