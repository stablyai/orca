import {
  sanitizeCrashReportDetails,
  type CrashReportBreadcrumbData
} from '../../shared/crash-reporting'

/**
 * Driver identity for crash details.
 *
 * Nothing in the main process called app.getGPUInfo() before, so every GPU
 * crash bundle arrived without a vendor, device or driver version — triage
 * could not tell a broken driver from a broken machine.
 */

/** Bounded so a pathological glExtensions-style string can't dominate the report. */
const MAX_GPU_STRING_LENGTH = 160

type UnknownRecord = Record<string, unknown>

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null
}

function pickString(source: UnknownRecord | null, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, MAX_GPU_STRING_LENGTH)
    : undefined
}

function pickNumber(source: UnknownRecord | null, key: string): number | undefined {
  const value = source?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pickBoolean(source: UnknownRecord | null, key: string): boolean | undefined {
  const value = source?.[key]
  return typeof value === 'boolean' ? value : undefined
}

/** Vendor/device ids arrive as numbers; hex is what driver bug reports are indexed by. */
function formatPciId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `0x${Math.trunc(value).toString(16).padStart(4, '0')}`
  }
  return typeof value === 'string' && value.length > 0
    ? value.slice(0, MAX_GPU_STRING_LENGTH)
    : undefined
}

function selectGpuDevice(raw: UnknownRecord | null): UnknownRecord | null {
  const devices = raw?.gpuDevice
  if (!Array.isArray(devices) || devices.length === 0) {
    return null
  }
  const records = devices.map(asRecord).filter((device): device is UnknownRecord => device !== null)
  return records.find((device) => device.active === true) ?? records[0] ?? null
}

/**
 * Flattens `app.getGPUInfo('complete')` into crash-detail scalars. Pure so the
 * shape can be tested without an Electron GPU process.
 */
export function summarizeGpuInfo(raw: unknown): CrashReportBreadcrumbData {
  const root = asRecord(raw)
  if (!root) {
    return { gpuInfoAvailable: false }
  }
  const aux = asRecord(root.auxAttributes)
  const device = selectGpuDevice(root)
  const devices = Array.isArray(root.gpuDevice) ? root.gpuDevice.length : 0

  return sanitizeCrashReportDetails({
    gpuInfoAvailable: true,
    gpuDeviceCount: devices,
    gpuVendorId: formatPciId(device?.vendorId),
    gpuDeviceId: formatPciId(device?.deviceId),
    gpuDriverVendor: pickString(device, 'driverVendor'),
    gpuDriverVersion: pickString(device, 'driverVersion'),
    gpuDeviceString: pickString(device, 'deviceString'),
    gpuGlVendor: pickString(aux, 'glVendor'),
    gpuGlRenderer: pickString(aux, 'glRenderer'),
    gpuGlVersion: pickString(aux, 'glVersion'),
    gpuAnglePlatform: pickString(aux, 'glImplementation'),
    gpuBasicInfoState: pickNumber(aux, 'basicInfoState'),
    gpuContextInfoState: pickNumber(aux, 'contextInfoState'),
    gpuInitializationTimeMs: pickNumber(aux, 'initializationTime'),
    gpuInProcess: pickBoolean(aux, 'inProcessGpu'),
    gpuSandboxed: pickBoolean(aux, 'sandboxed'),
    gpuDirectComposition: pickBoolean(aux, 'directComposition'),
    gpuPassthroughCmdDecoder: pickBoolean(aux, 'passthroughCmdDecoder'),
    gpuMachineModel: pickString(root, 'machineModelName'),
    gpuMachineModelVersion: pickString(root, 'machineModelVersion')
  })
}

let gpuInfoSnapshot: CrashReportBreadcrumbData | null = null

export function getGpuInfoSnapshot(): CrashReportBreadcrumbData | null {
  return gpuInfoSnapshot
}

export function setGpuInfoSnapshotForTesting(snapshot: CrashReportBreadcrumbData | null): void {
  gpuInfoSnapshot = snapshot
}

/**
 * Captures the snapshot once, off the startup critical path. On a machine whose
 * GPU child CHECK-crashes at init this call can hang forever, so it is bounded
 * and records the failure shape rather than nothing.
 */
export async function captureGpuInfoSnapshot(
  getGpuInfo: () => Promise<unknown>,
  timeoutMs: number
): Promise<CrashReportBreadcrumbData> {
  let timer: NodeJS.Timeout | undefined
  try {
    const snapshot = await Promise.race([
      getGpuInfo().then(summarizeGpuInfo),
      new Promise<CrashReportBreadcrumbData>((resolve) => {
        timer = setTimeout(
          () => resolve({ gpuInfoAvailable: false, gpuInfoError: 'timeout' }),
          timeoutMs
        )
        timer.unref?.()
      })
    ])
    gpuInfoSnapshot = snapshot
    return snapshot
  } catch (error) {
    const snapshot = sanitizeCrashReportDetails({
      gpuInfoAvailable: false,
      gpuInfoError: error instanceof Error ? error.message : String(error)
    })
    gpuInfoSnapshot = snapshot
    return snapshot
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
