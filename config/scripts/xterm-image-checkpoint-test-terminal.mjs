import { createRequire } from 'node:module'
import { NodeTerminalRasterBackend } from '../../src/shared/node-terminal-raster-backend'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')
const { ImageAddon } = require(process.env.ORCA_IMAGE_CHECKPOINT_ADDON ?? '@xterm/addon-image')
const { SerializeAddon } = require('@xterm/addon-serialize')

export function terminal(browser = false, options = {}) {
  const core = new Terminal({
    cols: 20,
    rows: 10,
    scrollback: 20,
    allowProposedApi: true,
    logLevel: 'off'
  })
  const backend = new NodeTerminalRasterBackend({
    getCellSize: () => ({ width: 2, height: 2 }),
    getColors: () => ({
      foreground: { rgba: 0xffffffff },
      background: { rgba: 0x000000ff },
      ansi: []
    })
  })
  const addon = new ImageAddon({
    rasterBackend: browser ? undefined : backend,
    pixelLimit: 8_000_000,
    storageLimit: 32,
    enableSizeReports: false,
    kittySizeLimit: 8 * 1024 * 1024,
    iipSizeLimit: 8 * 1024 * 1024,
    sixelSizeLimit: 8 * 1024 * 1024,
    ...options
  })
  const serializer = new SerializeAddon()
  core.loadAddon(addon)
  core.loadAddon(serializer)
  return {
    core,
    addon,
    backend,
    serializer,
    storage: addon._storage,
    kittyStorage: addon._handlers.get('kitty')._kittyStorage
  }
}
