import { statfsSync } from 'node:fs'
import { app } from 'electron'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'

const DEV_SHM_PATH = '/dev/shm'
const DEV_SHM_OVERRIDE_ENV_VAR = 'ORCA_DEV_SHM'
// Docker/Codespaces often provide only 64MiB; Chromium ring buffers/textures can exhaust it and crash every reload.
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

/** Use disk-backed Chromium shared memory on Linux containers with tiny/missing /dev/shm. */
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
  // Respect an existing user switch; headless serve also appends its own.
  if (disable && !app.commandLine.hasSwitch('disable-dev-shm-usage')) {
    app.commandLine.appendSwitch('disable-dev-shm-usage')
  }
  recordCrashBreadcrumb('dev_shm_policy', {
    ...(reading ? { devShmTotalMB: reading.totalMib, devShmFreeMB: reading.freeMib } : {}),
    devShmUsageDisabled: disable,
    reason
  })
}
