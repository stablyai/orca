import { isWindowsArm64 } from '../windows-arm64'

export function getAgentBrowserBinaryName(platform: NodeJS.Platform, architecture: string): string {
  // Why: keep this fallback aligned with config/windows-package-architecture.cjs;
  // upstream supports its x64 executable through Windows ARM emulation.
  const binaryArchitecture = isWindowsArm64(platform, architecture) ? 'x64' : architecture
  const extension = platform === 'win32' ? '.exe' : ''
  return `agent-browser-${platform}-${binaryArchitecture}${extension}`
}
