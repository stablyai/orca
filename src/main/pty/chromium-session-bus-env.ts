const CHROMIUM_DISABLED_SESSION_BUS = 'disabled:'

/** Remove Chromium's no-bus marker so children try $XDG_RUNTIME_DIR/bus; preserve real addresses. */
export function removeChromiumDisabledSessionBus(env: Record<string, string | undefined>): void {
  if (env.DBUS_SESSION_BUS_ADDRESS === CHROMIUM_DISABLED_SESSION_BUS) {
    delete env.DBUS_SESSION_BUS_ADDRESS
  }
}
