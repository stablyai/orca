import { join } from 'node:path'
import type { HarmonyCommandRunner } from './harmony-command-runner'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'

export type HarmonyEmulatorInstance = {
  name: string
  instancePath: string
  imageRoot: string
  imageSubPath?: string
  uuid?: string
  isRunning: boolean
  hdcPort?: number
  deviceType?: string
  lcdWidth?: number
  lcdHeight?: number
  apiVersion?: string
}

export const listDetailsArgs: readonly string[] = ['-list', '-details']
export const listNamesArgs: readonly string[] = ['-list']

// Parses `Emulator -list -details` JSON. Each entry carries `isRunning` as a
// string and optional numeric fields as strings, so values are normalized.
export function parseInstanceDetails(stdout: string): HarmonyEmulatorInstance[] {
  const parsed = parseJson(stdout)
  if (!Array.isArray(parsed)) {
    return []
  }

  const instances: HarmonyEmulatorInstance[] = []
  for (const entry of parsed) {
    if (
      !isRecord(entry) ||
      typeof entry.name !== 'string' ||
      typeof entry.instancePath !== 'string'
    ) {
      continue
    }
    instances.push({
      name: entry.name,
      instancePath: entry.instancePath,
      imageRoot: typeof entry.imageRoot === 'string' ? entry.imageRoot : '',
      ...(typeof entry.imageSubPath === 'string' ? { imageSubPath: entry.imageSubPath } : {}),
      ...(typeof entry.uuid === 'string' ? { uuid: entry.uuid } : {}),
      isRunning: entry.isRunning === 'true',
      ...(optionalNumber(entry['hw.hdc.port']) !== undefined
        ? { hdcPort: optionalNumber(entry['hw.hdc.port']) }
        : {}),
      ...(typeof entry.deviceType === 'string' ? { deviceType: entry.deviceType } : {}),
      ...(optionalNumber(entry['hw.lcd.single.width']) !== undefined
        ? { lcdWidth: optionalNumber(entry['hw.lcd.single.width']) }
        : {}),
      ...(optionalNumber(entry['hw.lcd.single.height']) !== undefined
        ? { lcdHeight: optionalNumber(entry['hw.lcd.single.height']) }
        : {}),
      ...(typeof entry['os.apiVersion'] === 'string' ? { apiVersion: entry['os.apiVersion'] } : {})
    })
  }
  return instances
}

// Parses `Emulator -list` output: one instance name per line. Names may contain
// spaces (e.g. "Mate 90 Pro"), so lines are not split on whitespace.
export function parseInstanceNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('['))
}

export type InstanceDirectoryIO = {
  deployedRoots: readonly string[]
  listDirectory: (dir: string) => string[]
}

// Lists deployed instances via the Emulator binary (details JSON, then plain
// names), filling gaps from the deployed instance directories.
export async function listHarmonyEmulatorInstances(
  runner: HarmonyCommandRunner,
  sdk: HarmonySdkPaths,
  io: InstanceDirectoryIO
): Promise<HarmonyEmulatorInstance[]> {
  const details = await runner(sdk.emulator, listDetailsArgs)
  if (details.code === 0) {
    const parsed = parseInstanceDetails(details.stdout)
    if (parsed.length > 0) {
      return withDirectoryFallbacks(parsed, io)
    }
  }

  const namesResult = await runner(sdk.emulator, listNamesArgs)
  const named = namesResult.code === 0 ? parseInstanceNames(namesResult.stdout) : []
  return withDirectoryFallbacks(
    named.map((name) => ({
      name,
      instancePath: firstExistingPath(io, name) ?? '',
      imageRoot: '',
      isRunning: false
    })),
    io
  )
}

function withDirectoryFallbacks(
  instances: HarmonyEmulatorInstance[],
  io: InstanceDirectoryIO
): HarmonyEmulatorInstance[] {
  const known = new Set(instances.map((instance) => instance.name))
  const merged = [...instances]
  for (const root of io.deployedRoots) {
    for (const name of io.listDirectory(root)) {
      if (!known.has(name)) {
        known.add(name)
        merged.push({
          name,
          instancePath: join(root, name),
          imageRoot: '',
          isRunning: false
        })
      }
    }
  }
  return merged
}

function firstExistingPath(io: InstanceDirectoryIO, name: string): string | null {
  for (const root of io.deployedRoots) {
    if (io.listDirectory(root).includes(name)) {
      return join(root, name)
    }
  }
  return null
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' || value === 'notset' || value.trim() === '') {
    return undefined
  }
  const num = Number(value)
  return Number.isFinite(num) ? num : undefined
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch {
    const match = /\[[\s\S]*\]/.exec(stdout)
    if (!match) {
      return null
    }
    try {
      return JSON.parse(match[0])
    } catch {
      return null
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
