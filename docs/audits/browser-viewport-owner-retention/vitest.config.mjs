import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import base from '../../../config/vitest.config.ts'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Set ORCA_BACKGROUND_LAUNCH=1 for the viewport ownership replay')
}

const target = fileURLToPath(
  new URL('../../../src/main/browser/browser-manager-viewport.ts', import.meta.url)
).replaceAll('\\', '/')

export default {
  ...base,
  test: {
    ...base.test,
    include: ['src/main/browser/browser-manager-viewport-ownership.test.ts']
  },
  plugins:
    process.env.ORCA_VIEWPORT_BASELINE === '1'
      ? [
          {
            name: 'viewport-owner-baseline',
            enforce: 'pre',
            transform(_source, id) {
              return id.replaceAll('\\', '/').split('?')[0] === target
                ? {
                    code: readFileSync(new URL('./baseline-source.txt', import.meta.url), 'utf8'),
                    map: null
                  }
                : null
            }
          }
        ]
      : []
}
