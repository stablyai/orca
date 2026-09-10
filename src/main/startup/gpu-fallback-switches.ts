/** Minimal surface of `app.commandLine` this module needs, so callers can be tested. */
export type GpuFallbackCommandLine = {
  appendSwitch(name: string, value?: string): void
}

export type GpuFallbackSwitchOptions = {
  /**
   * Why: Linux dev hosts (NVIDIA/hybrid drivers, missing render nodes) fail every GPU
   * child launch with error_code=1002 until Chromium fatal-exits; packaged Linux stays
   * untouched because no packaged telemetry supports a global hardware-acceleration cut.
   */
  linuxDevFallback?: boolean
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

/** Windows always gets the fallback; Linux only in an explicitly requested dev session. */
function resolveGpuFallbackSwitches(
  platform: NodeJS.Platform,
  options: GpuFallbackSwitchOptions = {}
): readonly string[] {
  return platform === 'win32' || (platform === 'linux' && options.linuxDevFallback === true)
    ? GPU_FALLBACK_COMMAND_LINE_SWITCHES
    : []
}

export function applyGpuFallbackCommandLineSwitches(
  commandLine: GpuFallbackCommandLine,
  platform: NodeJS.Platform,
  options: GpuFallbackSwitchOptions = {}
): readonly string[] {
  const switches = resolveGpuFallbackSwitches(platform, options)
  for (const name of switches) {
    commandLine.appendSwitch(name)
  }
  return switches
}
