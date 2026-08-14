export type WindowsDesktopStartupServices = {
  firstWindowReady: Promise<void>
  localPtyReady: Promise<void>
  localPtyProviderReady: Promise<void>
}

type WindowsDesktopShellPathStartupOptions<TWindow> = {
  openWindow: () => TWindow
  shellPathReady: Promise<void>
  startServices: () => WindowsDesktopStartupServices
}

export function startWindowsDesktopBeforeShellPathReady<TWindow>(
  options: WindowsDesktopShellPathStartupOptions<TWindow>
): { window: TWindow; services: Promise<WindowsDesktopStartupServices> } {
  const services = options.shellPathReady.then(options.startServices)
  return { window: options.openWindow(), services }
}
