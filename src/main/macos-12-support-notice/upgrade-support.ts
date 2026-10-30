import { release } from 'node:os'
import { app } from 'electron'
import { runProcess } from '@orca/process-host'
import type { MacosUpgradeSupport } from '../../shared/macos-12-support-notice/upgrade-support'
import { getIntelMacos13Support } from './ventura-intel-models'

let support: Promise<MacosUpgradeSupport> | undefined

export function getMacosUpgradeSupport(): Promise<MacosUpgradeSupport | null> {
  if (process.platform !== 'darwin' || !release().startsWith('21.')) {
    return Promise.resolve(null)
  }
  if (process.arch === 'arm64' || app.runningUnderARM64Translation) {
    return Promise.resolve({ macos13: 'supported', modelIdentifier: null })
  }
  return (support ??= readIntelModel().catch(() => ({
    macos13: 'unknown',
    modelIdentifier: null
  })))
}

async function readIntelModel(): Promise<MacosUpgradeSupport> {
  const result = await runProcess({
    program: '/usr/sbin/sysctl',
    args: ['-n', 'hw.model'],
    timeoutMs: 1_000,
    maxOutputBytes: 128
  })
  const modelIdentifier =
    result.code === 0 && !result.timedOut && !result.outputTruncated
      ? result.stdout.trim() || null
      : null
  return {
    macos13: modelIdentifier ? getIntelMacos13Support(modelIdentifier) : 'unknown',
    modelIdentifier
  }
}
