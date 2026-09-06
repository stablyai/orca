import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defaultExclude, defineConfig } from 'vitest/config'

// Every test file that opens ORCA_RELAY_TEST_POSTGRES_URL shares one CI
// database, and those tests take session-level locks with a 1s lock_timeout.
// Running them alongside anything else collides into lock timeouts, capacity
// exhaustion, and afterAll hangs. Keep them in their own serialized project so
// only they give up file parallelism; the rest of the suite opens SQLite data
// directories and stays fully parallel.
const sourceDirectory = fileURLToPath(new URL('src', import.meta.url))
const sharedPostgresTests = readdirSync(sourceDirectory)
  .filter((entry) => entry.endsWith('.test.ts'))
  .filter((entry) =>
    readFileSync(`${sourceDirectory}/${entry}`, 'utf8').includes(
      'ORCA_RELAY_TEST_POSTGRES_URL'
    )
  )
  .map((entry) => `src/${entry}`)

const timeouts = { testTimeout: 15_000, hookTimeout: 15_000 }

export default defineConfig({
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
