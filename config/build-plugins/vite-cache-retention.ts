import { resolve } from 'node:path'
import type { Plugin } from 'vite'
import { retainViteCache } from '../scripts/vite-cache-activity.mjs'

export function createViteCacheRetentionPlugin(cacheRoot = resolve('.cache/vite')): Plugin {
  return {
    name: 'orca-vite-cache-retention',
    apply: 'serve',
    async configureServer(server) {
      const release = await retainViteCache(cacheRoot)
      const close = server.close.bind(server)
      // Keep ownership until Vite has stopped its optimizer and outstanding requests.
      server.close = async (...args) => {
        try {
          await close(...args)
        } finally {
          await release()
        }
      }
    }
  }
}
