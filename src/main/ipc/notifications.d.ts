import type { Store } from '../persistence';
export declare function registerNotificationHandlers(store: Store): void;
/**
 * On first launch, when macOS notification permission is 'not-determined',
 * show a welcome notification to trigger the system permission dialog.
 *
 * Why: macOS requires at least one notification attempt before the system
 * will prompt the user to allow/deny. Doing this at startup with meaningful
 * content avoids a confusing blank notification later. The notification is
 * closed shortly after to avoid lingering in Notification Center.
 */
export declare function triggerStartupNotificationRegistration(store: Store): void;
