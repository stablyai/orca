import { app } from 'electron'
import { runProcess } from '@orca/process-host'
import { isVenturaRequirement, type MacosUpgradeSupport } from '../../shared/macos-upgrade-support'

// Ventura's Intel model boundaries: https://support.apple.com/en-us/102861.
const VENTURA_INTEL_MODELS = {
  MacBook: [10, 10],
  MacBookAir: [8, 9],
  MacBookPro: [14, 16],
  Macmini: [8, 8],
  iMac: [18, 20],
  iMacPro: [1, 1],
  MacPro: [7, 7]
} as const

export function getIntelVenturaSupport(modelIdentifier: string): MacosUpgradeSupport {
  const match =
    /^(MacBookAir|MacBookPro|MacBook|Macmini|iMacPro|iMac|MacPro)([1-9]\d*),[1-9]\d*$/u.exec(
      modelIdentifier
    )
  const limits = match
    ? Object.entries(VENTURA_INTEL_MODELS).find(([name]) => name === match[1])?.[1]
    : undefined
  if (!match || !limits) {
    return 'unknown'
  }
  const major = Number(match[2])
  if (major < limits[0]) {
    return 'unsupported'
  }
  return major <= limits[1] ? 'supported' : 'unknown'
}

let intelVenturaSupport: Promise<MacosUpgradeSupport> | undefined

async function readIntelVenturaSupport(): Promise<MacosUpgradeSupport> {
  const result = await runProcess({
    program: '/usr/sbin/sysctl',
    args: ['-n', 'hw.model'],
    timeoutMs: 1_000,
    maxOutputBytes: 128
  })
  const model =
    result.code === 0 && !result.timedOut && !result.outputTruncated ? result.stdout.trim() : ''
  return model ? getIntelVenturaSupport(model) : 'unknown'
}

/** Whether Apple supports `minimumMacosVersion` on this Mac; only macOS 13.x has model data. */
export function getMacosUpgradeSupport(minimumMacosVersion: unknown): Promise<MacosUpgradeSupport> {
  if (process.platform !== 'darwin') {
    return Promise.resolve('unknown')
  }
  // Every Apple Silicon Mac supports macOS 13 through 26.
  if (process.arch === 'arm64' || app.runningUnderARM64Translation) {
    return Promise.resolve('supported')
  }
  if (!isVenturaRequirement(minimumMacosVersion)) {
    return Promise.resolve('unknown')
  }
  return (intelVenturaSupport ??= readIntelVenturaSupport().catch(() => 'unknown'))
}
