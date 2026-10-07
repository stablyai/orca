import { ImageAddon } from '@xterm/addon-image'
import { NodeTerminalRasterBackend } from '../../shared/node-terminal-raster-backend'
import { buildInlineImageAddonOptions } from '../../shared/terminal-inline-image-options'
import type { HeadlessInlineImageConfiguration } from './headless-model-checkpoint'
import type { TerminalViewAttributeResponder } from './terminal-view-attribute-responder'
import {
  readTerminalImageCellSize,
  type TerminalImageCellSize
} from '../../shared/terminal-image-cell-size'

export function updateHeadlessImageCellSize(
  images: HeadlessInlineImageConfiguration | undefined,
  cellSize: TerminalImageCellSize | undefined,
  pendingWrites: number
): void {
  if (!images || cellSize === undefined) {
    return
  }
  const measured = readTerminalImageCellSize(cellSize)
  if (!measured) {
    throw new Error('Invalid terminal image cell size')
  }
  if (pendingWrites > 0) {
    throw new Error('Terminal writes must drain before image geometry changes')
  }
  images.cellSize = measured
}

export function createHeadlessImageAddon(
  images: HeadlessInlineImageConfiguration,
  colors: TerminalViewAttributeResponder
): ImageAddon {
  return new ImageAddon({
    ...buildInlineImageAddonOptions(),
    ...images.options,
    rasterBackend: new NodeTerminalRasterBackend({
      getCellSize: () => images.cellSize,
      getColors: () => colors.readImageColors(images.colors)
    })
  })
}
