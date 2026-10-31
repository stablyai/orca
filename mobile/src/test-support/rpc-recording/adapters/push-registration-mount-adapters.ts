import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'

// Expose private senders to record wire behavior without inventing keychain and device-token storage in substitutes.
export const pushRegistrationMountExposures: readonly OperationExposure[] = [
  ['notifications/push-registration.ts', '\nexports.sendUnregister = sendUnregister;']
]

const REGISTER_TIMEOUT_MS = 5_000

export function pushRegistrationMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'notifications.push-registration': ({ client }) => {
      const push = modules.load<{
        sendUnregister: (client: unknown, timeoutMs: number) => Promise<boolean>
      }>('mobile/src/notifications/push-registration.ts')
      const { sendRegister } = modules.load<{
        sendRegister: (client: unknown, params: unknown) => Promise<{ status: string }>
      }>('mobile/src/notifications/mobile-push-registration-operations.ts')
      const results: Record<string, unknown> = {}
      return {
        action(name, args) {
          if (name !== 'register' && name !== 'unregister') {
            throw new Error(`Unknown push registration action: ${name}`)
          }
          const request =
            name === 'unregister'
              ? push.sendUnregister(client, Number(args.timeoutMs ?? REGISTER_TIMEOUT_MS))
              : sendRegister(client, {
                  platform: 'ios',
                  token: 'apns-token-1',
                  apnsEnvironment: args.sandbox === true ? 'sandbox' : 'production',
                  filter: { onlyWhenDesktopAway: true, sound: args.sound !== false }
                }).then((observation) => observation.status === 'registered')
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
