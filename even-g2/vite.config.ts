import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      '@orca-shared': path.resolve(__dirname, '../src/shared')
    }
  },
  server: {
    port: 5173,
    fs: {
      // Explicit allow list REPLACES Vite's default (workspace root), so this project's own
      // root must be re-added alongside ../src/shared — dev binds 0.0.0.0, and the prior '..'
      // would have exposed the entire repo via /@fs/.
      allow: [path.resolve(__dirname), path.resolve(__dirname, '../src/shared')]
    }
  }
})
