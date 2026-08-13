// Synthetic webpack config read only for its `resolve.alias` shape, by madge's
// webpack-config resolver (which uses enhanced-resolve, not TypeScript's `ts.sys` —
// madge's --ts-config mode crashes under this repo's typescript@7 since ts.sys is
// undefined there). This file is never run through an actual webpack build.
//
// Keep this alias in sync with the renderer's `@/*` -> `src/renderer/src/*` mapping
// in tsconfig.json / config/tsconfig.tc.web.json.
const path = require('node:path')

module.exports = {
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '..', 'src/renderer/src')
    },
    extensions: ['.ts', '.tsx', '.js', '.jsx']
  }
}
