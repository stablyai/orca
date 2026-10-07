import type { ImageAddon } from '@xterm/addon-image'
import { imageCheckpointMetadataBytes } from '@xterm/addon-image/src/ImageCheckpointMetadata'
import { CHECKPOINT_LEASE_BYTES } from '@xterm/addon-image/src/ImageCheckpointResources'
import { TerminalModelCheckpoint as HeadlessModelCheckpoint } from '../../shared/terminal-model-checkpoint'
import {
  validateModelCheckpointConfiguration,
  type HeadlessModelConfiguration
} from '../../shared/terminal-model-checkpoint-configuration'
import type { TerminalSnapshot } from './terminal-snapshot'
import type { TerminalViewAttributeResponder } from './terminal-view-attribute-responder'
export { TerminalModelCheckpoint as HeadlessModelCheckpoint } from '../../shared/terminal-model-checkpoint'
export type { TerminalModelCheckpointMetadata as HeadlessModelCheckpointMetadata } from '../../shared/terminal-model-checkpoint'
export { copyHeadlessModelConfiguration } from '../../shared/terminal-model-checkpoint-configuration'
export type {
  HeadlessModelConfiguration,
  HeadlessInlineImageConfiguration
} from '../../shared/terminal-model-checkpoint-configuration'

export function requireDrainedImageAddon(
  addon: ImageAddon | undefined,
  disposed: boolean,
  pendingWrites: number
): ImageAddon {
  if (disposed) {
    throw new Error('Headless terminal is disposed')
  }
  if (pendingWrites > 0) {
    throw new Error('Terminal writes must drain before checkpoint capture')
  }
  if (!addon) {
    throw new Error('Headless terminal image support is not configured')
  }
  return addon
}

export function captureHeadlessModelCheckpoint(
  configuration: HeadlessModelConfiguration,
  snapshot: TerminalSnapshot,
  addon: ImageAddon,
  maxBytes: number,
  viewAttributes?: TerminalViewAttributeResponder
): HeadlessModelCheckpoint {
  snapshot = {
    ...snapshot,
    rehydrateSequences:
      (viewAttributes?.serializeColorOverrides() ?? '') + snapshot.rehydrateSequences
  }
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
          colors:
            viewAttributes?.readImageColors(configuration.images.colors, false) ??
            configuration.images.colors,
          options: {
            ...configuration.images.options,
            storageLimit: addon.storageLimit,
            showPlaceholder: addon.showPlaceholder
          }
        }
      : undefined
  }
  validateModelCheckpointConfiguration(capturedConfiguration)
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
