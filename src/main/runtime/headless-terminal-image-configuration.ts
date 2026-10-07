import type { HeadlessInlineImageConfiguration } from '../daemon/headless-model-checkpoint'
import { imageColor } from '../daemon/terminal-view-attribute-responder'
import { readTerminalImageCellSize } from '../../shared/terminal-image-cell-size'
import { getTerminalViewAttributes } from './terminal-view-attribute-store'
import type { RuntimeHeadlessTerminal } from './runtime-terminal-state-records'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'

export function readHeadlessTerminalImageConfiguration(
  cellSize: unknown
): HeadlessInlineImageConfiguration | undefined {
  const measured = readTerminalImageCellSize(cellSize)
  const attributes = getTerminalViewAttributes()
  if (!measured || !attributes) {
    return undefined
  }
  return {
    cellSize: measured,
    colors: {
      foreground: imageColor(attributes.foreground),
      background: imageColor(attributes.background),
      ansi: attributes.ansi.map(imageColor)
    }
  }
}

export function readHeadlessImageReplacementConfiguration(
  state: RuntimeHeadlessTerminal | undefined,
  generation: number,
  incarnation: PtyIncarnationId | null | undefined
): HeadlessInlineImageConfiguration | undefined {
  const images = state?.emulator.imageConfiguration
  const accepted = state?.acceptedImageCellSize
  if (images && accepted?.generation === generation && accepted.incarnation === incarnation) {
    images.cellSize = { ...accepted.cellSize }
  }
  return images
}
