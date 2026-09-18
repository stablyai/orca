import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'

const workflowsDir = fileURLToPath(new URL('../../.github/workflows', import.meta.url))

// Every script whose chain reaches build:mobile-web. build:unpack -> build -> build:desktop, and
// build:mac/linux/win each call build:desktop, so all of them produce out/mobile-web.
const BUNDLE_PRODUCER =
  /pnpm (?:run )?(?:build|build:desktop|build:release|build:release:parallel|build:unpack|build:mobile-web|build:mac|build:mac:release|build:linux|build:win)(?=$|[\s'"&|;])/m

function packagingJobs() {
  const jobs = []
  for (const file of readdirSync(workflowsDir).filter((name) => name.endsWith('.yml'))) {
    const document = parse(readFileSync(join(workflowsDir, file), 'utf8'))
    for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
      const text = stringify(job)
      const invocations = [...text.matchAll(/[^\n]*electron-builder --config[^\n]*/g)].map(
        (match) => match[0]
      )
      if (invocations.length === 0) {
        continue
      }
      // --prepackaged short-circuits doPack before emitBeforePack, so those jobs never run the guard.
      if (invocations.every((invocation) => invocation.includes('--prepackaged'))) {
        continue
      }
      jobs.push({ file, jobName, text })
    }
  }
  return jobs
}

describe('mobile web bundle packaging coverage', () => {
  it('finds the packaging jobs', () => {
    // A rename or a restructure that empties this list would make every assertion below vacuous.
    expect(packagingJobs().length).toBeGreaterThanOrEqual(8)
  })

  it.each(packagingJobs().map((job) => [`${job.file} ${job.jobName}`, job]))(
    'produces out/mobile-web before electron-builder packs: %s',
    (_label, job) => {
      // Job granularity, not step ordering: the failure this exists for is a job that never builds
      // the bundle at all, which is what beforePack turns into a hard packaging failure.
      expect(job.text).toMatch(BUNDLE_PRODUCER)
    }
  )
})
