import { statfsSync } from 'node:fs'
import { app } from 'electron'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'

const DEV_SHM_PATH = '/dev/shm'
const DEV_SHM_OVERRIDE_ENV_VAR = 'ORCA_DEV_SHM'
// Why 512: Docker/Codespaces default to 64 MB, where Chromium's ring-buffer and
// texture allocations fail and IMMEDIATE_CRASH the renderer on every reload.
const MIN_DEV_SHM_TOTAL_MIB = 512
const MIB = 1024 * 1024

type DevShmReading = { totalMib: number; freeMib: number } | null

function readDevShm(): DevShmReading {
  try {
    const stats = statfsSync(DEV_SHM_PATH)
    return {
      totalMib: Math.floor((stats.blocks * stats.bsize) / MIB),
      freeMib: Math.floor((stats.bavail * stats.bsize) / MIB)
    }
  } catch {
    return null
  }
}

/**
 * On Linux hosts with a tiny or missing /dev/shm (containers, Codespaces),
 * back Chromium shared memory with /tmp files instead of letting renderers abort.
 */
export function configureLinuxDevShmUsage(): void {
  if (process.platform !== 'linux') {
    return
  }
  const override = (process.env[DEV_SHM_OVERRIDE_ENV_VAR] ?? '').trim().toLowerCase()
  const reading = readDevShm()
  const reason =
    override === 'off' || override === 'force'
      ? override
      : reading === null
        ? 'unreadable'
        : reading.totalMib < MIN_DEV_SHM_TOTAL_MIB
          ? 'small'
          : 'ok'
  const disable = reason === 'force' || reason === 'small' || reason === 'unreadable'
  // Why hasSwitch: user argv may already carry it (headless serve appends its own later).
  if (disable && !app.commandLine.hasSwitch('disable-dev-shm-usage')) {
    app.commandLine.appendSwitch('disable-dev-shm-usage')
  }
  recordCrashBreadcrumb('dev_shm_policy', {
    ...(reading ? { devShmTotalMB: reading.totalMib, devShmFreeMB: reading.freeMib } : {}),
    devShmUsageDisabled: disable,
    reason
  })
}
