import { ipcMain, Notification } from 'electron'
import type { ClaudeRuntimeAuthService } from '../../claude-accounts/runtime-auth-service'
import { ClaudeAccountRotationService } from '../../claude-accounts/rotation/claude-rotation-service'
import { showDesktopNotification } from '../../notifications/desktop-notification'
import type { Store } from '../../persistence/loading-store/store'
import type { RateLimitService } from '../../rate-limits/service/rate-limit-service'

let installed: ClaudeAccountRotationService | null = null

/** Starts the login rotation timer and its status handler once per process; desktop main only. */
export function installClaudeAccountRotation(args: {
  store: Store
  claudeRuntimeAuth: ClaudeRuntimeAuthService
  rateLimits: RateLimitService
  dataRoot: string
}): ClaudeAccountRotationService {
  if (installed) {
    return installed
  }
  const service = new ClaudeAccountRotationService({
    store: args.store,
    router: args.claudeRuntimeAuth.router,
    rateLimits: args.rateLimits,
    dataRoot: args.dataRoot,
    notify: ({ title, body }) => {
      if (Notification.isSupported()) {
        void showDesktopNotification(new Notification({ title, body }))
      }
    }
  })
  ipcMain.handle('claudeAccounts:rotationStatus', () => service.getStatus())
  service.start()
  installed = service
  return service
}
