export type WindowsDesktopStartupServices = {
  firstWindowReady: Promise<void>
  localPtyReady: Promise<void>
  localPtyProviderReady: Promise<void>
}

type WindowsDesktopShellPathStartupOptions<TWindow> = {
  bindServices: (services: Promise<WindowsDesktopStartupServices>) => void
  openWindow: () => TWindow
  shellPathReady: Promise<void>
  startServices: () => WindowsDesktopStartupServices
}

export function startWindowsDesktopBeforeShellPathReady<TWindow>(
  options: WindowsDesktopShellPathStartupOptions<TWindow>
): { window: TWindow; services: Promise<WindowsDesktopStartupServices> } {
  const services = options.shellPathReady.then(options.startServices)
  options.bindServices(services)
  return { window: options.openWindow(), services }
}
