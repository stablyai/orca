import { ImageAddon } from '@xterm/addon-image'
import { NodeTerminalRasterBackend } from '../../shared/node-terminal-raster-backend'
import { buildInlineImageAddonOptions } from '../../shared/terminal-inline-image-options'
import type { HeadlessInlineImageConfiguration } from './headless-model-checkpoint'
import type { TerminalViewAttributeResponder } from './terminal-view-attribute-responder'

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
