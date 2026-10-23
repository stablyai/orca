/** What Chromium writes into its own env when it starts without a session bus. */
const CHROMIUM_DISABLED_SESSION_BUS = 'disabled:'

/** Drops Chromium's no-bus marker so children fall back to `$XDG_RUNTIME_DIR/bus`; a real address is kept. */
export function removeChromiumDisabledSessionBus(env: Record<string, string | undefined>): void {
  if (env.DBUS_SESSION_BUS_ADDRESS === CHROMIUM_DISABLED_SESSION_BUS) {
    delete env.DBUS_SESSION_BUS_ADDRESS
  }
}
