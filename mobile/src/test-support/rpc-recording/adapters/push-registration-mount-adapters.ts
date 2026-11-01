import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

// Expose private senders to record wire behavior without inventing keychain and device-token storage in substitutes.
export const pushRegistrationMountExposures: readonly OperationExposure[] = [
  [
    'notifications/push-registration.ts',
    '\nexports.sendRegister = sendRegister;\nexports.sendUnregister = sendUnregister;'
  ]
]

const REGISTER_TIMEOUT_MS = 5_000

export function pushRegistrationMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'notifications.push-registration': ({ client }) => {
      const push = modules.load<{
        sendRegister: (client: unknown, token: unknown, filter: unknown) => Promise<boolean>
        sendUnregister: (client: unknown, timeoutMs: number) => Promise<boolean>
      }>('mobile/src/notifications/push-registration.ts')
      const results: Record<string, unknown> = {}
      return {
        action(name, args) {
          if (name !== 'register' && name !== 'unregister') {
            throw new Error(`Unknown push registration action: ${name}`)
          }
          const request =
            name === 'unregister'
              ? push.sendUnregister(client, Number(args.timeoutMs ?? REGISTER_TIMEOUT_MS))
              : push.sendRegister(
                  client,
                  {
                    platform: 'ios',
                    token: 'apns-token-1',
                    apnsEnvironment: args.sandbox === true ? 'sandbox' : 'production'
                  },
                  { onlyWhenDesktopAway: true, sound: args.sound !== false }
                )
          return request.then((value: unknown) => {
            results[name] = value
            return value
          })
        },
        state: () => ({ ...results }),
        dispose: () => {}
      }
    }
  }
}
