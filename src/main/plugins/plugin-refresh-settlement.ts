export async function waitForPluginRefreshSettlement(
  getCurrent: () => Promise<void>
): Promise<void> {
  while (true) {
    const pending = getCurrent()
    await pending.catch(() => undefined)
    if (pending === getCurrent()) {
      return
    }
  }
}
