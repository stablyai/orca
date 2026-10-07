import { ImageAddon, type IImageAddonOptions } from '@xterm/addon-image'
import type { IImageColors } from '@xterm/addon-image/src/ImageRasterBackend'
import type {
  IImageAddonCheckpoint,
  IImageAddonCheckpointMetadata
} from '@xterm/addon-image/src/ImageCheckpointApi'
import {
  imageCheckpointMetadataBytes,
  ownImageCheckpointMetadata
} from '@xterm/addon-image/src/ImageCheckpointMetadata'
import { CHECKPOINT_LEASE_BYTES } from '@xterm/addon-image/src/ImageCheckpointResources'
import { advancePartialEscapeTail } from '../../shared/terminal-partial-escape-tail'
import {
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX,
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
} from '../../shared/terminal-scrollback-policy'
import { buildInlineImageAddonOptions } from '../../shared/terminal-inline-image-options'
import { isValidTerminalHistorySize } from './terminal-history-dimensions'
import type { TerminalSnapshot } from './terminal-snapshot'

export type HeadlessInlineImageConfiguration = {
  cellSize: { width: number; height: number }
  colors: IImageColors
  options?: Omit<IImageAddonOptions, 'rasterBackend'>
}

export type HeadlessModelConfiguration = {
  cols: number
  rows: number
  scrollback?: number
  pathFlavor?: 'posix' | 'win32'
  remotePosixFileUriAuthority?: boolean
  wslDistro?: string
  images?: HeadlessInlineImageConfiguration
}

export type HeadlessModelCheckpointMetadata = {
  version: 1
  configuration: HeadlessModelConfiguration
  snapshot: TerminalSnapshot
  graphics: IImageAddonCheckpointMetadata
  metadataByteLength: number
  byteLength: number
}

export function copyHeadlessModelConfiguration(
  opts: HeadlessModelConfiguration
): HeadlessModelConfiguration {
  return {
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback ?? DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
    pathFlavor: opts.pathFlavor,
    remotePosixFileUriAuthority: opts.remotePosixFileUriAuthority,
    wslDistro: opts.wslDistro,
    images: opts.images ? structuredClone(opts.images) : undefined
  }
}

function validateConfiguration(configuration: HeadlessModelConfiguration): void {
  const { images, scrollback = DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } = configuration
  if (
    !isValidTerminalHistorySize(configuration.cols, configuration.rows) ||
    !Number.isSafeInteger(scrollback) ||
    scrollback < 0 ||
    scrollback > DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX ||
    !images ||
    !Number.isFinite(images.cellSize.width) ||
    images.cellSize.width <= 0 ||
    !Number.isFinite(images.cellSize.height) ||
    images.cellSize.height <= 0
  ) {
    throw new Error('Invalid complete terminal checkpoint configuration')
  }
  const colors = [images.colors.foreground, images.colors.background, ...images.colors.ansi]
  if (
    images.colors.ansi.length > 256 ||
    colors.some(
      (color) => !Number.isSafeInteger(color.rgba) || color.rgba < 0 || color.rgba > 0xffffffff
    )
  ) {
    throw new Error('Invalid complete terminal checkpoint colors')
  }
  const options = images.options ?? {}
  const defaults = buildInlineImageAddonOptions()
  for (const key of ['pixelLimit', 'sixelSizeLimit', 'iipSizeLimit', 'kittySizeLimit'] as const) {
    const value = options[key]
    const ceiling = defaults[key]
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < 1 || ceiling === undefined || value > ceiling)
    ) {
      throw new Error('Invalid complete terminal checkpoint image limits')
    }
  }
  if (
    (options.storageLimit !== undefined &&
      (!Number.isFinite(options.storageLimit) ||
        options.storageLimit < 0.5 ||
        options.storageLimit > 1000)) ||
    (options.sixelPaletteLimit !== undefined &&
      (!Number.isSafeInteger(options.sixelPaletteLimit) ||
        options.sixelPaletteLimit < 1 ||
        options.sixelPaletteLimit > 4096))
  ) {
    throw new Error('Invalid complete terminal checkpoint image options')
  }
  for (const key of [
    'enableSizeReports',
    'showPlaceholder',
    'sixelSupport',
    'sixelScrolling',
    'iipSupport',
    'kittySupport'
  ] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') {
      throw new Error('Invalid complete terminal checkpoint image options')
    }
  }
}

export class HeadlessModelCheckpoint {
  private header: HeadlessModelCheckpointMetadata | null
  private readonly graphics: IImageAddonCheckpoint

  constructor(metadata: HeadlessModelCheckpointMetadata, resources: Map<number, Uint8Array>) {
    try {
      const owned = ownImageCheckpointMetadata(metadata)
      validateConfiguration(owned.configuration)
      const { snapshot } = owned
      if (
        owned.version !== 1 ||
        snapshot.cols !== owned.configuration.cols ||
        snapshot.rows !== owned.configuration.rows ||
        typeof snapshot.snapshotAnsi !== 'string' ||
        typeof snapshot.scrollbackAnsi !== 'string' ||
        typeof snapshot.rehydrateSequences !== 'string' ||
        (snapshot.cwd !== null && typeof snapshot.cwd !== 'string') ||
        snapshot.modes.alternateScreen !== (owned.graphics.activeBuffer === 'alternate') ||
        owned.metadataByteLength !== imageCheckpointMetadataBytes(owned) ||
        owned.byteLength !== owned.graphics.resourceByteLength + owned.metadataByteLength ||
        owned.byteLength > CHECKPOINT_LEASE_BYTES
      ) {
        throw new Error('Invalid complete terminal checkpoint header')
      }
      const text = snapshot.scrollbackAnsi + snapshot.rehydrateSequences + snapshot.snapshotAnsi
      const imageIntroducers = ['\x1bP', '\x1b_', '\x1b]1337;', '\u0090', '\u009f', '\u009d1337;']
      if (imageIntroducers.some((introducer) => text.includes(introducer))) {
        throw new Error('Image input cannot be replayed as checkpoint text')
      }
      const tail = snapshot.pendingEscapeTailAnsi ?? ''
      if (
        advancePartialEscapeTail('', tail) !== tail ||
        (tail && owned.graphics.components.some((part) => part.kind.endsWith('-active')))
      ) {
        throw new Error('Invalid complete terminal checkpoint parser ownership')
      }
      this.graphics = ImageAddon.checkpointFromResources(owned.graphics, resources)
      this.header = owned
    } catch (error) {
      resources.clear()
      throw error
    }
  }

  get metadata(): HeadlessModelCheckpointMetadata {
    if (!this.header) {
      throw new Error('Complete terminal checkpoint lease is disposed')
    }
    return this.header
  }

  get isDisposed(): boolean {
    return this.header === null || this.graphics.isDisposed
  }

  checkCurrent(): void {
    if (this.isDisposed) {
      throw new Error('Complete terminal checkpoint lease is disposed')
    }
  }

  getResourceByteLength(id: number): number {
    this.checkCurrent()
    return this.graphics.getResourceByteLength(id)
  }
  readResource(id: number, offset: number, length: number): Uint8Array {
    this.checkCurrent()
    return this.graphics.readResource(id, offset, length)
  }
  copyResource(id: number, maxBytes: number): Uint8Array {
    this.checkCurrent()
    return this.graphics.copyResource(id, maxBytes)
  }

  async restoreImages(addon: ImageAddon): Promise<void> {
    this.checkCurrent()
    await addon.restoreCheckpoint(this.graphics)
    this.checkCurrent()
  }

  dispose(): void {
    this.graphics.dispose()
    this.header = null
  }
}

export function captureHeadlessModelCheckpoint(
  configuration: HeadlessModelConfiguration,
  snapshot: TerminalSnapshot,
  addon: ImageAddon,
  maxBytes: number
): HeadlessModelCheckpoint {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > CHECKPOINT_LEASE_BYTES) {
    throw new RangeError('Invalid complete terminal checkpoint budget')
  }
  const capturedConfiguration = {
    ...configuration,
    cols: snapshot.cols,
    rows: snapshot.rows,
    images: configuration.images
      ? {
          ...configuration.images,
          options: {
            ...configuration.images.options,
            storageLimit: addon.storageLimit,
            showPlaceholder: addon.showPlaceholder
          }
        }
      : undefined
  }
  validateConfiguration(capturedConfiguration)
  const base = {
    version: 1 as const,
    configuration: capturedConfiguration,
    snapshot: { ...snapshot, pendingEscapeTailAnsi: undefined },
    metadataByteLength: 0,
    byteLength: 0
  }
  const outerBytes =
    imageCheckpointMetadataBytes({ ...base, graphics: null }) - imageCheckpointMetadataBytes(null)
  if (outerBytes > maxBytes) {
    throw new RangeError('Complete terminal checkpoint exceeds budget')
  }
  const graphics = addon.captureCheckpoint(maxBytes - outerBytes)
  try {
    const active = graphics.metadata.components.some((part) => part.kind.endsWith('-active'))
    const header = {
      version: 1 as const,
      configuration: capturedConfiguration,
      snapshot: active ? { ...snapshot, pendingEscapeTailAnsi: undefined } : snapshot,
      graphics: graphics.metadata,
      metadataByteLength: 0,
      byteLength: 0
    }
    const metadataByteLength = imageCheckpointMetadataBytes(header)
    const byteLength = graphics.metadata.resourceByteLength + metadataByteLength
    if (byteLength > maxBytes) {
      throw new RangeError('Complete terminal checkpoint exceeds budget')
    }
    return new HeadlessModelCheckpoint(
      { ...header, metadataByteLength, byteLength },
      graphics.takeResources()
    )
  } finally {
    graphics.dispose()
  }
}
