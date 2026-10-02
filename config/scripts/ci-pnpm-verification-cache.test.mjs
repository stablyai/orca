import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const action = parse(readFileSync('.github/actions/install-node-dependencies/action.yml', 'utf8'))
const steps = action.runs.steps
const resolve = steps.find((step) => step.id === 'verification-cache')
const restore = steps.find((step) => step.id === 'verification-cache-restore')
const install = steps.find((step) => step.name === 'Install dependencies')
const save = steps.find((step) => step.name === 'Save pnpm verification record on main')
const evaluate = (expression, context) =>
  runInNewContext(
    expression.replaceAll('inputs.cache-pnpm-verification', 'inputs["cache-pnpm-verification"]'),
    context
  )

describe('pnpm-owned verification record', () => {
  it.each([
    ['Linux', 'X64', true],
    ['Linux', 'ARM64', true],
    ['Linux', 'X86', true],
    ['Windows', 'X64', true],
    ['Windows', 'ARM64', true],
    ['Windows', 'X86', false],
    ['macOS', 'X64', true],
    ['macOS', 'ARM64', false],
    ['macOS', 'X86', false]
  ])('%s %s cache=%s retains the explicit opt-out', (os, arch, expected) => {
    for (const enabled of ['true', 'false']) {
      expect(
        evaluate(resolve.if, {
          runner: { os, arch },
          inputs: { 'cache-pnpm-verification': enabled }
        })
      ).toBe(expected && enabled === 'true')
    }
  })

  it('keeps existing Linux keys and separates OS, architecture, pnpm and policy', () => {
    expect(resolve.env.POLICY_HASH).toBe(
      "${{ hashFiles('pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc') }}"
    )
    expect(resolve.run).toContain('"$(pnpm cache path)"')
    expect(resolve.run).toContain('lockfile-verified.jsonl')
    expect(resolve.run).toContain('pnpm-verification-v1-%s-%s-%s-%s')
    expect(resolve.run).toContain('"$RUNNER_OS" "$RUNNER_ARCH" "$(pnpm --version)" "$POLICY_HASH"')
    expect(restore.uses).toBe('actions/cache/restore@v5')
    expect(restore.with.path).toBe('${{ steps.verification-cache.outputs.path }}')
    expect(restore.with['restore-keys']).toBeUndefined()
    expect(restore['continue-on-error']).toBe(true)
    expect(steps.indexOf(restore)).toBeLessThan(steps.indexOf(install))
    expect(install.if).toBeUndefined()
    expect(install.run).toContain('pnpm install --frozen-lockfile --ignore-scripts')
  })

  it.each([
    ['push', 'refs/heads/main', true],
    ['schedule', 'refs/heads/main', true],
    ['workflow_dispatch', 'refs/heads/main', true],
    ['pull_request', 'refs/heads/main', false],
    ['push', 'refs/heads/feature', false]
  ])('%s on %s retains the main-only write boundary', (event, ref, expected) => {
    const context = {
      github: { event_name: event, ref },
      steps: {
        'verification-cache': { outputs: { key: 'a-key' } },
        'verification-cache-restore': { outputs: { 'cache-hit': 'false' } }
      }
    }
    const expression = save.if
      .replaceAll(
        'steps.verification-cache-restore.outputs.cache-hit',
        'steps["verification-cache-restore"].outputs["cache-hit"]'
      )
      .replaceAll('steps.verification-cache.outputs.key', 'steps["verification-cache"].outputs.key')
    expect(evaluate(expression, context)).toBe(expected)
    context.steps['verification-cache'].outputs.key = ''
    expect(evaluate(expression, context)).toBe(false)
    context.steps['verification-cache'].outputs.key = 'a-key'
    context.steps['verification-cache-restore'].outputs['cache-hit'] = 'true'
    expect(evaluate(expression, context)).toBe(false)
    expect(save.uses).toBe('actions/cache/save@v5')
    expect(steps.indexOf(save)).toBeGreaterThan(steps.indexOf(install))
  })
})
