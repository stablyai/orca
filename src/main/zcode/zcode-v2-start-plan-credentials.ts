import { join } from 'node:path'
import { z } from 'zod'
import {
  decryptZcodeV2Secret,
  localZcodeCredentialHost,
  readZcodeV2File,
  zcodeV2DataDir
} from './zcode-v2-plan-credentials'

const credentialStoreSchema = z.record(z.string(), z.string())

export type ZcodeV2StartPlanCredential =
  | { status: 'absent' | 'unavailable' | 'error' }
  | { status: 'ok'; jwt: string; deviceMid: string }

/** Start Plan usage is keyed to the ZCode OAuth session JWT plus the device id the client reports. */
export function readZcodeV2StartPlanCredential(
  host = localZcodeCredentialHost()
): ZcodeV2StartPlanCredential {
  const v2Dir = join(zcodeV2DataDir(host), '.zcode', 'v2')
  let rawStore: string
  try {
    rawStore = readZcodeV2File(join(v2Dir, 'credentials.json'))
  } catch (error) {
    return {
      status:
        error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'absent' : 'error'
    }
  }
  try {
    const store = credentialStoreSchema.parse(JSON.parse(rawStore))
    const jwt = decryptZcodeV2Secret(store['zcodejwttoken'] ?? '', host).trim()
    if (!jwt || /[\r\n]/.test(jwt)) {
      return { status: 'unavailable' }
    }
    const telemetry: unknown = JSON.parse(readZcodeV2File(join(v2Dir, 'telemetry-state.json')))
    const deviceMid =
      typeof telemetry === 'object' && telemetry !== null && 'deviceMid' in telemetry
        ? telemetry.deviceMid
        : undefined
    if (typeof deviceMid !== 'string' || !deviceMid.trim() || /[\r\n]/.test(deviceMid)) {
      return { status: 'unavailable' }
    }
    return { status: 'ok', jwt, deviceMid: deviceMid.trim() }
  } catch {
    return { status: 'error' }
  }
}
