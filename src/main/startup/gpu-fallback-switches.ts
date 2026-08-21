/** Minimal surface of `app.commandLine` this module needs, so callers can be tested. */
export type GpuFallbackCommandLine = {
  appendSwitch(name: string, value?: string): void
}

/**
 * Why: `disableHardwareAcceleration()` + `--disable-gpu` still spawns a GPU child
 * (measured on Windows 11 / Electron 43.1.0) — it only drops the backend to software
 * GL, so a GPU process being killed by a bad driver or injected DLL keeps dying after
 * the fallback engages. `--in-process-gpu` is the only switch that removes the child.
 * SwiftShader is disabled because `--in-process-gpu` would otherwise move untrusted
 * WebGL command parsing into Orca's privileged main process. Terminals safely fall
 * back to the DOM renderer in this post-crash mode.
 */
const GPU_FALLBACK_COMMAND_LINE_SWITCHES = [
  'disable-gpu',
  'disable-software-rasterizer',
  'in-process-gpu'
] as const

/** Software rendering is a Windows-only post-crash fallback; every other platform gets nothing. */
function resolveGpuFallbackSwitches(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32' ? GPU_FALLBACK_COMMAND_LINE_SWITCHES : []
}

export function applyGpuFallbackCommandLineSwitches(
  commandLine: GpuFallbackCommandLine,
  platform: NodeJS.Platform
): readonly string[] {
  const switches = resolveGpuFallbackSwitches(platform)
  for (const name of switches) {
    commandLine.appendSwitch(name)
  }
  return switches
}
