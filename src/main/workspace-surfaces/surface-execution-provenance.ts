import { readFile } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import { readBootIdentity } from '../agent-hooks/managed-hook-owner-identity'
import { parseDarwinPlatformUuid } from '../persistence/profile-state/profile-state-access-identity'
import type { SurfaceExecutionProvenance } from '../../shared/workspace-surfaces/surface-execution-provenance'

let provenance: Promise<SurfaceExecutionProvenance> | undefined

/** Observe this executor's kernel before election; failure remains explicitly unverifiable. */
export function readSurfaceExecutionProvenance(): Promise<SurfaceExecutionProvenance> {
  return (provenance ??= readProvenance())
}

async function readProvenance(): Promise<SurfaceExecutionProvenance> {
  const platform =
    process.platform === 'darwin' || process.platform === 'linux' || process.platform === 'win32'
      ? process.platform
      : 'unknown'
  let machineId: string | null = null
  let kernel: SurfaceExecutionProvenance['kernel'] = null
  try {
    if (platform === 'linux') {
      const value = (await readFile('/etc/machine-id', 'utf8')).trim().toLowerCase()
      if (/^[a-f0-9]{32}$/.test(value) && !/^0+$/.test(value)) {
        machineId = `linux-machine-id:${value}`
      }
    } else if (platform === 'darwin') {
      const result = await runProcess({
        program: '/usr/sbin/ioreg',
        args: ['-rd1', '-c', 'IOPlatformExpertDevice'],
        timeoutMs: 1_000,
        maxOutputBytes: 64 * 1024
      })
      const value = result.code === 0 ? parseDarwinPlatformUuid(result.stdout) : null
      if (value) {
        machineId = `darwin-platform-uuid:${value}`
      }
    }
  } catch {}
  try {
    const value = (await readBootIdentity())?.toLowerCase()
    if (
      value &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) &&
      !/^[0-]+$/.test(value)
    ) {
      if (platform === 'linux') {
        kernel = { scheme: 'linux-boot-id-v1', value }
      }
      if (platform === 'darwin') {
        kernel = { scheme: 'darwin-bootsession-v1', value }
      }
    }
  } catch {}
  // Windows kernel epochs are not qualified; a launcher boot never proves a WSL guest writer died.
  return { platform, machineId, kernel }
}
