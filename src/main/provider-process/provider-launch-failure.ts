import { getSystemErrorName } from 'node:util'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import {
  isDefinitiveAbsence,
  withProviderSpawnAbsence,
  type ProviderSpawnAbsence
} from './provider-executable-missing'
import type { ProviderSpawnSpec } from './provider-process-supervisor'

export async function reportProviderLaunchFailure(
  error: unknown,
  launch: Pick<ProviderSpawnSpec, 'cwd' | 'command'>,
  notifyFailure: (failure: Error) => void
): Promise<Error> {
  await Promise.resolve()
  const source = error instanceof Error ? error : new Error(String(error))
  let absence: ProviderSpawnAbsence | null = null
  if ('code' in source && source.code === 'ENOENT') {
    try {
      await stat(launch.cwd)
    } catch (failure) {
      if (isDefinitiveAbsence(failure)) {
        absence = 'launchFolder'
      }
    }
    if (!absence && 'path' in source && source.path === launch.command) {
      if (!isAbsolute(launch.command)) {
        absence = 'executable'
      } else {
        try {
          await stat(launch.command)
        } catch (failure) {
          if (isDefinitiveAbsence(failure)) {
            absence = 'executable'
          }
        }
      }
    }
  }
  const failure = Object.assign(withProviderSpawnAbsence(source, absence), {
    providerSpawnAbsence: absence,
    providerLaunchFailed: true
  })
  notifyFailure(failure)
  return failure
}

export function providerExecFailure(command: string, errno: number): Error {
  let code = 'UNKNOWN'
  try {
    code = getSystemErrorName(-errno)
  } catch {}
  return Object.assign(new Error(`spawn ${command} ${code}`), {
    code,
    errno,
    path: command
  })
}
