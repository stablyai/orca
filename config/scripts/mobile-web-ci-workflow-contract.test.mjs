import { readFileSync } from 'node:fs'

import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const prWorkflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const mobileWorkflow = parse(readFileSync('.github/workflows/mobile.yml', 'utf8'))

describe('mobile web CI workflow contract', () => {
  it('typechecks the standalone client in PR CI', () => {
    const commands = prWorkflow.jobs.typecheck.steps.flatMap((step) => step.run ?? [])

    expect(commands).toContain('pnpm run typecheck:mobile-web')
  })

  it('runs mobile checks for client and bridge changes', () => {
    expect(mobileWorkflow.on.pull_request.paths).toEqual(
      expect.arrayContaining(['src/mobile-web/**', 'src/shared/mobile-web/**'])
    )
  })
})
