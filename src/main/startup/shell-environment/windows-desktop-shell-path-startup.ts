// A first launch after an update loaded 1.7s after the window was created on an 8-core laptop.
const WINDOWS_FIRST_WINDOW_LOAD_FALLBACK_MS = 5_000

export type WindowsDesktopStartupServices = {
  firstWindowReady: Promise<void>
  localPtyReady: Promise<void>
  localPtyProviderReady: Promise<void>
}

type WindowsDesktopShellPathStartupOptions<TWindow> = {
  bindServices: (services: Promise<WindowsDesktopStartupServices>) => void
  /** Call `onLoadSettled` once the first document has loaded or failed to load. */
  openWindow: (onLoadSettled: () => void) => TWindow
  shellPathReady: Promise<void>
  startServices: () => WindowsDesktopStartupServices
}

export function startWindowsDesktopBeforeShellPathReady<TWindow>(
  options: WindowsDesktopShellPathStartupOptions<TWindow>
): { window: TWindow; services: Promise<WindowsDesktopStartupServices> } {
  // Staging and launching the terminal daemon can block main before the first window appears.
  const firstWindowLoad = Promise.withResolvers<void>()
  const fallback = setTimeout(firstWindowLoad.resolve, WINDOWS_FIRST_WINDOW_LOAD_FALLBACK_MS)
  fallback.unref()
  const services = Promise.all([options.shellPathReady, firstWindowLoad.promise]).then(
    options.startServices
  )
  options.bindServices(services)
  const window = options.openWindow(() => {
    clearTimeout(fallback)
    setImmediate(firstWindowLoad.resolve)
  })
  return { window, services }
}
