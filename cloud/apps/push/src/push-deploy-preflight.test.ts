import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { loadPushConfig } from './config.js'

it('runs the deployment image preflight against the actual config loader', () => {
  const workflow = readFileSync(
    new URL('../../../../.github/workflows/cloud-push-deploy.yml', import.meta.url),
    'utf8'
  )
  const step = workflow.split('- name: Require image support for inert validation')[1]!
  const script = step.match(/--input-type=module -e '([\s\S]*?)'/)?.[1]
  expect(script).toBeDefined()
  const run = new Function('loadPushConfig', script!.replace(/import .*?;/, ''))
  expect(() => run(loadPushConfig)).not.toThrow()
  expect(() => run(() => ({ mode: 'active' }))).toThrow('validation_mode_unsupported')
  expect(() => run(() => ({ mode: 'validation' }))).toThrow('validation_mode_not_fail_closed')
})
