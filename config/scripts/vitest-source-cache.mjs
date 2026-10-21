import { createHash } from 'node:crypto'
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export function sourceCacheIdentity(root) {
  const files = globSync('**/*', {
    cwd: root,
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      '**/.cache/**',
      '**/out/**',
      '**/dist/**',
      'mobile/vendor/**'
    ]
  })
    .filter((file) => /\.(?:[cm]?[jt]sx?|json)$/.test(file))
    .sort()
  const hash = createHash('sha256')
  hash.update(JSON.stringify([process.platform, process.arch, process.versions]))
  for (const file of files) {
    hash.update(file).update('\0')
    // Config and package exports can change an unchanged importer's transformation or resolution.
    if (file.endsWith('.json')) {
      hash.update(readFileSync(join(root, file))).update('\0')
    }
  }
  return hash.digest('hex')
}

export function createSourceCachePlugin(root = process.cwd()) {
  let identity
  return {
    name: 'orca-vitest-source-cache',
    configureVitest({ vitest, defineCacheKeyGenerator }) {
      defineCacheKeyGenerator(({ environment }) => {
        // Watch sessions can add files after this inventory; keep their live invalidation authoritative.
        if (vitest.config.watch) {
          return false
        }
        identity ??= sourceCacheIdentity(root)
        return identity + JSON.stringify([environment.config.define, environment.config.env])
      })
    }
  }
}
