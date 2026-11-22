export type GpuFallbackCommandLine = {
  appendSwitch(name: string, value?: string): void
}

/** Windows 11/Electron 43.1 keeps a GPU child with disable-gpu. in-process-gpu removes it; disable SwiftShader to keep untrusted WebGL parsing out of privileged main. Terminals use DOM fallback. */
const GPU_FALLBACK_COMMAND_LINE_SWITCHES = [
  'disable-gpu',
  'disable-software-rasterizer',
  'in-process-gpu'
] as const

/** Post-crash software fallback is Windows-only. */
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
