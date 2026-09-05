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
      // Why: dev server must serve ../src/shared, which sits above project root.
      allow: [path.resolve(__dirname, '..')]
    }
  }
})
