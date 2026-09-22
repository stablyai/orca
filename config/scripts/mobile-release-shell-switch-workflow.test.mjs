import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

/**
 * Every mobile release is the native app unless one workflow input says otherwise.
 *
 * The phone reads `EXPO_PUBLIC_MOBILE_SHELL` once, at build time, through Expo's env inlining — so
 * the only thing standing between a scheduled or tag-triggered release and a binary that mounts
 * the web page is what these two workflows put in that variable. A default that drifted, or a
 * build step that stopped carrying the variable, would ship the wrong app with nothing else
 * failing.
 */
const projectDir = resolve(import.meta.dirname, '../..')
const SWITCH = 'EXPO_PUBLIC_MOBILE_SHELL'
const RELEASE_WORKFLOWS = {
  android: {
    file: 'mobile-android-release.yml',
    job: 'android-build',
    step: 'Build Android release APK'
  },
  ios: { file: 'mobile-ios-release.yml', job: 'ios-build', step: 'Build and upload to TestFlight' }
}

function workflowOf(file) {
  return parse(readFileSync(resolve(projectDir, '.github/workflows', file), 'utf8'))
}

function stepsOf(workflow) {
  return Object.entries(workflow.jobs).flatMap(([job, body]) =>
    (body.steps ?? []).map((step) => ({ job, step }))
  )
}

/** The steps that hand the switch down to whatever they run. */
function switchCarriers(workflow) {
  return stepsOf(workflow).filter(({ step }) => step.env?.[SWITCH] !== undefined)
}

/**
 * What GitHub does with `${{ inputs.<name> || '<fallback>' }}`, and the whole reason a run with no
 * inputs reads native: on a `push` or a `schedule` the `inputs` context is null, and `||` yields
 * its right operand for null and for the empty string alike.
 *
 * Narrow on purpose. Anything but this one expression shape is a failure rather than something to
 * interpret, because a shape this test cannot evaluate is one it cannot make a claim about.
 */
function evaluateInputExpression(expression, inputs) {
  const match = /^\$\{\{\s*inputs\.([A-Za-z_]\w*)\s*\|\|\s*'([^']*)'\s*\}\}$/.exec(expression)
  expect(match, `unevaluatable expression: ${expression}`).not.toBeNull()
  const [, name, fallback] = match
  const supplied = inputs?.[name]
  return supplied === undefined || supplied === null || supplied === '' ? fallback : supplied
}

describe.each(Object.entries(RELEASE_WORKFLOWS))(
  'the %s release workflow',
  (_platform, { file, job, step: stepName }) => {
    const workflow = workflowOf(file)

    it('offers the shell as a two-option choice that defaults to native', () => {
      const input = workflow.on.workflow_dispatch.inputs.shell

      expect(input.type).toBe('choice')
      expect(input.options).toEqual(['native', 'ota'])
      expect(input.default).toBe('native')
      expect(input.description).toMatch(/native/i)
      expect(input.description).toMatch(/ota/i)
    })

    it('hands the switch to the step that bundles the JavaScript, and to no other step', () => {
      const carriers = switchCarriers(workflow)

      expect(carriers.map(({ job: owner, step }) => `${owner}: ${step.name}`)).toEqual([
        `${job}: ${stepName}`
      ])
    })

    it('builds native when no input was supplied, which is every tag push and every schedule', () => {
      const { step } = switchCarriers(workflow)[0]

      expect(evaluateInputExpression(step.env[SWITCH], undefined)).toBe('native')
      expect(evaluateInputExpression(step.env[SWITCH], {})).toBe('native')
      expect(evaluateInputExpression(step.env[SWITCH], { shell: '' })).toBe('native')
      expect(evaluateInputExpression(step.env[SWITCH], { shell: 'native' })).toBe('native')
      expect(evaluateInputExpression(step.env[SWITCH], { shell: 'ota' })).toBe('ota')
    })

    it('prints the value it is about to build with, read from the same variable', () => {
      const { step } = switchCarriers(workflow)[0]

      // Not a second copy of the expression: a log line built from its own literal could disagree
      // with the build beside it, and a run would then report a shell it did not ship.
      expect(step.run).toContain(`echo "Mobile shell: $${SWITCH}"`)
    })
  }
)

it('leaves the switch out of every other workflow, so only a release can set it', () => {
  const workflows = ['mobile.yml', 'pr.yml', 'mobile-android-release.yml', 'mobile-ios-release.yml']
  const setters = workflows.filter((file) => switchCarriers(workflowOf(file)).length > 0)

  expect(setters).toEqual(['mobile-android-release.yml', 'mobile-ios-release.yml'])
})
