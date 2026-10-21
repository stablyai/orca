import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultExclude, defineConfig } from 'vitest/config'

// PostgreSQL files share session locks and a small connection budget.
// The runner overlaps this serialized project with SQLite tests after other packages finish.
const sourceDirectory = fileURLToPath(new URL('src', import.meta.url))
const sharedPostgresTests = readdirSync(sourceDirectory)
  .filter((entry) => entry.endsWith('.test.ts'))
  .filter((entry) =>
    readFileSync(join(sourceDirectory, entry), 'utf8').includes('ORCA_RELAY_TEST_POSTGRES_URL')
  )
  .map((entry) => `src/${entry}`)

const timeouts = { testTimeout: 15_000, hookTimeout: 15_000 }

export default defineConfig({
  cacheDir: process.env.ORCA_RELAY_TEST_CACHE_DIR,
  test: {
    projects: [
      {
        test: {
          ...timeouts,
          name: 'relay',
          include: ['src/**/*.test.ts'],
          exclude: [...defaultExclude, ...sharedPostgresTests]
        }
      },
      {
        test: {
          ...timeouts,
          name: 'relay-postgres',
          include: sharedPostgresTests,
          fileParallelism: false
        }
      }
    ]
  }
})
