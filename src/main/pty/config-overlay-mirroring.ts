import { mkdirSync, opendirSync, realpathSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { mirrorEntry } from './overlay-mirror'

export const CONFIG_OVERLAY_MAX_SOURCE_ENTRIES = 4_096
export const CONFIG_OVERLAY_MAX_ENTRY_NAME_BYTES = 4 * 1_024
export const CONFIG_OVERLAY_MAX_RETAINED_NAME_BYTES = 1_024 * 1_024

export type ConfigOverlayCapacityKind = 'entries' | 'entry-name-bytes' | 'retained-name-bytes'

export type ConfigOverlayLimits = {
  maxEntries: number
  maxEntryNameBytes: number
  maxRetainedNameBytes: number
}

const DEFAULT_LIMITS: ConfigOverlayLimits = {
  maxEntries: CONFIG_OVERLAY_MAX_SOURCE_ENTRIES,
  maxEntryNameBytes: CONFIG_OVERLAY_MAX_ENTRY_NAME_BYTES,
  maxRetainedNameBytes: CONFIG_OVERLAY_MAX_RETAINED_NAME_BYTES
}

export class ConfigOverlayCapacityError extends Error {
  constructor(
    readonly kind: ConfigOverlayCapacityKind,
    readonly observed: number,
    readonly limit: number
  ) {
    super(`Agent config overlay ${kind} exceeded its ${limit} limit (observed ${observed})`)
    this.name = 'ConfigOverlayCapacityError'
  }
}

export class ConfigOverlayEntryBudget {
  private entryCount = 0
  private retainedNameBytes = 0
  private readonly limits: ConfigOverlayLimits

  constructor(requested?: Partial<ConfigOverlayLimits>) {
    this.limits = {
      maxEntries: resolveLimit(requested?.maxEntries, DEFAULT_LIMITS.maxEntries, 'maxEntries'),
      maxEntryNameBytes: resolveLimit(
        requested?.maxEntryNameBytes,
        DEFAULT_LIMITS.maxEntryNameBytes,
        'maxEntryNameBytes'
      ),
      maxRetainedNameBytes: resolveLimit(
        requested?.maxRetainedNameBytes,
        DEFAULT_LIMITS.maxRetainedNameBytes,
        'maxRetainedNameBytes'
      )
    }
  }

  reserve(name: string): void {
    const nextEntryCount = this.entryCount + 1
    if (nextEntryCount > this.limits.maxEntries) {
      throw new ConfigOverlayCapacityError('entries', nextEntryCount, this.limits.maxEntries)
    }

    const nameBytes = Buffer.byteLength(name, 'utf8')
    if (nameBytes > this.limits.maxEntryNameBytes) {
      throw new ConfigOverlayCapacityError(
        'entry-name-bytes',
        nameBytes,
        this.limits.maxEntryNameBytes
      )
    }
    assertPortableEntryName(name)

    const retainedNameBytes = Buffer.byteLength(JSON.stringify(name), 'utf8')
    const nextRetainedNameBytes = this.retainedNameBytes + retainedNameBytes
    if (nextRetainedNameBytes > this.limits.maxRetainedNameBytes) {
      throw new ConfigOverlayCapacityError(
        'retained-name-bytes',
        nextRetainedNameBytes,
        this.limits.maxRetainedNameBytes
      )
    }

    this.entryCount = nextEntryCount
    this.retainedNameBytes = nextRetainedNameBytes
  }
}

export type ConfigOverlayPlan = {
  sourceDir: string
  topLevelEntryNames: string[]
  pluginSourceDir: string | null
  pluginEntryNames: string[]
}

export type AppliedConfigOverlayEntries = {
  topLevelEntryNames: string[]
  pluginEntryNames: string[]
}

type ConfigOverlayPlanOptions = {
  reservedPluginFile: string
  reservedTopLevelEntryNames?: ReadonlySet<string>
}

function resolveLimit(requested: number | undefined, maximum: number, name: string): number {
  if (requested === undefined) {
    return maximum
  }
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return Math.min(requested, maximum)
}

function assertPortableEntryName(name: string): void {
  if (name.length === 0 || name === '.' || name === '..' || /[/\\]/.test(name)) {
    throw new Error('Agent config overlay contains a non-portable entry name')
  }
}

function closeDirectory(directory: ReturnType<typeof opendirSync>): void {
  try {
    directory.closeSync()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') {
      throw error
    }
  }
}

function scanOpenDirectory(
  directory: Pick<ReturnType<typeof opendirSync>, 'readSync'>,
  budget: ConfigOverlayEntryBudget,
  visit: (entry: Dirent) => void
): void {
  while (true) {
    const entry = directory.readSync()
    if (entry === null) {
      return
    }
    budget.reserve(entry.name)
    visit(entry)
  }
}

function scanDirectory(
  path: string,
  budget: ConfigOverlayEntryBudget,
  visit: (entry: Dirent) => void
): void {
  const directory = opendirSync(path, { bufferSize: 32 })
  try {
    scanOpenDirectory(directory, budget, visit)
  } finally {
    closeDirectory(directory)
  }
}

export function createConfigOverlayPlan(
  sourceDir: string,
  options: ConfigOverlayPlanOptions,
  budget = new ConfigOverlayEntryBudget()
): ConfigOverlayPlan {
  const topLevelEntryNames: string[] = []
  const pluginEntryNames: string[] = []
  let pluginSourceDir: string | null = null

  scanDirectory(sourceDir, budget, (entry) => {
    if (options.reservedTopLevelEntryNames?.has(entry.name)) {
      return
    }

    const sourcePath = join(sourceDir, entry.name)
    if (entry.name === 'plugins') {
      const isSymlink = entry.isSymbolicLink()
      let isLinkPointingToDir = false
      if (isSymlink) {
        try {
          isLinkPointingToDir = statSync(sourcePath).isDirectory()
        } catch {
          isLinkPointingToDir = false
        }
      }

      if ((!isSymlink && entry.isDirectory()) || isLinkPointingToDir) {
        pluginSourceDir = isLinkPointingToDir ? realpathSync(sourcePath) : sourcePath
        scanDirectory(pluginSourceDir, budget, (pluginEntry) => {
          if (pluginEntry.name !== options.reservedPluginFile) {
            pluginEntryNames.push(pluginEntry.name)
          }
        })
        return
      }
    }

    topLevelEntryNames.push(entry.name)
  })

  return { sourceDir, topLevelEntryNames, pluginSourceDir, pluginEntryNames }
}

export function applyConfigOverlayPlan(
  plan: ConfigOverlayPlan,
  targetDir: string,
  applied: AppliedConfigOverlayEntries = {
    topLevelEntryNames: [],
    pluginEntryNames: []
  }
): AppliedConfigOverlayEntries {
  for (const entryName of plan.topLevelEntryNames) {
    mirrorEntry(join(plan.sourceDir, entryName), join(targetDir, entryName))
    applied.topLevelEntryNames.push(entryName)
  }

  if (plan.pluginSourceDir === null) {
    return applied
  }

  const targetPluginsDir = join(targetDir, 'plugins')
  mkdirSync(targetPluginsDir, { recursive: true })
  for (const entryName of plan.pluginEntryNames) {
    mirrorEntry(join(plan.pluginSourceDir, entryName), join(targetPluginsDir, entryName))
    applied.pluginEntryNames.push(entryName)
  }
  return applied
}

export const _configOverlayMirroringInternals = {
  scanOpenDirectory
}
