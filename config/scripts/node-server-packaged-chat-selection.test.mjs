import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import { classifyNodeServerChanges } from './node-server-change-scope.mjs'
import { nodeServerTestPaths } from './node-server-test-paths.mjs'

it.each([
  'src/main/orcad/orcad-packaged-structured-chat.integration.test.ts',
  'src/main/runtime/new-launch-path.ts',
  'src/main/claude/__fixtures__/claude-agent-sdk-scripted-cli.mjs',
  'config/scripts/orcad-entry-build.mjs',
  'config/scripts/future-orcad-package.mjs'
])('runs the packaged structured chat when its inputs change: %s', async (file) => {
  expect((await classifyNodeServerChanges([file], async () => new Set())).shouldRun).toBe(true)
})

it('runs a real structured chat on Linux from the built desktop template', () => {
  const workflow = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))
  const steps = workflow.jobs.persistence.steps
  const chat = steps.find((step) =>
    step.run?.includes('orcad-packaged-structured-chat.integration.test.ts')
  )
  expect(chat.if).toBe("runner.os == 'Linux'")
  expect(chat.run).toBe(
    'pnpm test:node-server --artifact src/main/orcad/orcad-packaged-structured-chat.integration.test.ts --maxWorkers=2'
  )
  const template = steps.find((step) => step.run?.includes('build-orcad-template.mjs --targets'))
  expect(template.if).toBe("runner.os == 'Linux'")
  expect(template.run).toBe(
    "node config/scripts/build-orcad-template.mjs --targets linux-${{ runner.arch == 'ARM64' && 'arm64' || 'x64' }}-glibc"
  )
  expect(steps.indexOf(template)).toBeGreaterThan(
    steps.findIndex((step) => step.run === 'pnpm build:orcad')
  )
  expect(steps.indexOf(chat)).toBeGreaterThan(steps.indexOf(template))
  expect(template['continue-on-error']).toBeUndefined()
  expect(chat['continue-on-error']).toBeUndefined()
  // Default --artifact runs have no template, so a required-input failure would follow.
  expect(nodeServerTestPaths({ artifact: true, crossRuntime: true })).not.toContain(
    'src/main/orcad/orcad-packaged-structured-chat.integration.test.ts'
  )
})
