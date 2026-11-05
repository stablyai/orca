export type GpuFallbackCommandLine = {
  appendSwitch(name: string, value?: string): void
}

/** Windows 11/Electron 43.1 keeps a GPU child with disable-gpu. in-process-gpu removes it; disable SwiftShader to keep untrusted WebGL parsing out of privileged main. Terminals use DOM fallback. */
const WINDOWS_GPU_FALLBACK_COMMAND_LINE_SWITCHES = [
  'disable-gpu',
  'disable-software-rasterizer',
  'in-process-gpu'
] as const

/** #21336/#38590: Linux GPU crashes recover with software compositing; in-process-gpu and SwiftShader removal stay Windows-only. */
const LINUX_GPU_FALLBACK_COMMAND_LINE_SWITCHES = ['disable-gpu', 'disable-gpu-compositing'] as const

/** Post-crash software fallback is Windows and Linux only. */
function resolveGpuFallbackSwitches(platform: NodeJS.Platform): readonly string[] {
  if (platform === 'win32') {
    return WINDOWS_GPU_FALLBACK_COMMAND_LINE_SWITCHES
  }
  if (platform === 'linux') {
    return LINUX_GPU_FALLBACK_COMMAND_LINE_SWITCHES
  }
  return []
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
