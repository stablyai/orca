import { ImageAddon } from '@xterm/addon-image'
import { NodeTerminalRasterBackend } from '../../shared/node-terminal-raster-backend'
import { buildInlineImageAddonOptions } from '../../shared/terminal-inline-image-options'
import type { HeadlessInlineImageConfiguration } from './headless-model-checkpoint'

export function createHeadlessImageAddon(images: HeadlessInlineImageConfiguration): ImageAddon {
  return new ImageAddon({
    ...buildInlineImageAddonOptions(),
    ...images.options,
    rasterBackend: new NodeTerminalRasterBackend({
      getCellSize: () => images.cellSize,
      getColors: () => images.colors
    })
  })
}
