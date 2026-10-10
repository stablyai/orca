import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { classifyPrJobs, PR_CHECK_JOBS } from './pr-code-change-scope.mjs'
import { runProcessSync } from '@orca/process-host'

const action = parse(readFileSync('.github/actions/install-node-dependencies/action.yml', 'utf8'))
const steps = action.runs.steps
const cache = steps.find((step) => step.id === 'verification-cache')
const cacheAction = parse(
  readFileSync('.github/actions/restore-pnpm-verification/action.yml', 'utf8')
)
const resolve = cacheAction.runs.steps.find((step) => step.id === 'verification-cache')
const restore = cacheAction.runs.steps.find((step) => step.id === 'verification-cache-restore')
const install = steps.find((step) => step.name === 'Install dependencies')
const save = steps.find((step) => step.name === 'Save pnpm verification record on main')
const evaluate = (expression, context) => runInNewContext(expression, context)

function resolveRecord({
  container = false,
  os = 'Linux',
  packageManager = 'pnpm@12.8.1+sha512.test'
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-verification-record-'))
  try {
    const output = join(root, 'outputs')
    const calls = join(root, 'pnpm-calls')
    const cacheRoot = join(root, 'cache with spaces')
    const cachePath = join(cacheRoot, 'pnpm')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager }))
    const execution = runProcessSync({
      program: 'bash',
      args: [
        '-e',
        '-o',
        'pipefail',
        '-c',
        `
        pnpm() {
          printf '%s\\n' "$*" >> "$TEST_CALLS"
          case "$*" in
            'cache path') printf '%s\\n' "$TEST_CACHE_PATH" ;;
            '--version') printf '%s\\n' '12.8.1' ;;
            *) return 2 ;;
          esac
        }
        ${resolve.run}
      `
      ],
      cwd: root,
      env: {
        ...process.env,
        RUNNER_OS: os,
        RUNNER_ARCH: 'ARM64',
        POLICY_HASH: 'policy-digest',
        GITHUB_OUTPUT: output,
        TEST_CALLS: calls,
        TEST_CACHE_PATH: cachePath,
        CONTAINER_TOOLCHAIN: String(container),
        XDG_CACHE_HOME: cacheRoot
      }
    })
    return {
      code: execution.code,
      output: existsSync(output) ? readFileSync(output, 'utf8').replaceAll(root, '<root>') : '',
      calls: existsSync(calls) ? readFileSync(calls, 'utf8') : ''
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('pnpm-owned verification record', () => {
  it('qualifies every shared-installer consumer when verification restoration changes', () => {
    const result = classifyPrJobs(['.github/actions/restore-pnpm-verification/action.yml'])
    for (const job of PR_CHECK_JOBS) {
      expect(result[job], job).toBe(true)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'shares the exact key and archive path with containers without invoking host pnpm',
    () => {
      const host = resolveRecord()
      const container = resolveRecord({ container: true })
      expect(host.code).toBe(0)
      expect(container.code).toBe(0)
      expect(container.output).toBe(host.output)
      expect(container.output).toContain(
        'path=<root>/cache with spaces/pnpm/lockfile-verified.jsonl'
      )
      expect(container.output).toContain(
        'key=pnpm-verification-v1-Linux-ARM64-12.8.1-policy-digest'
      )
      expect(host.calls).toBe('cache path\n--version\n')
      expect(container.calls).toBe('')
    }
  )

  it.skipIf(process.platform === 'win32').each([
    { container: true, os: 'Windows' },
    { container: true, os: 'macOS' },
    { container: true, packageManager: 'npm@12.8.1' }
  ])('rejects an unsupported container identity: %j', (options) => {
    const result = resolveRecord(options)
    expect(result.code).not.toBe(0)
    expect(result.output).toBe('')
    expect(result.calls).toBe('')
  })

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
          inputs: { enabled }
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
    expect(resolve.run).toContain('pnpm_version="$(pnpm --version)"')
    expect(resolve.run).toContain('"$RUNNER_OS" "$RUNNER_ARCH" "$pnpm_version" "$POLICY_HASH"')
    expect(cache.uses).toBe('./.github/actions/restore-pnpm-verification')
    expect(cache.with.enabled).toBe('${{ inputs.cache-pnpm-verification }}')
    expect(restore.uses).toBe('actions/cache/restore@v5')
    expect(restore.with.path).toBe('${{ steps.verification-cache.outputs.path }}')
    expect(restore.with['restore-keys']).toBeUndefined()
    expect(restore['continue-on-error']).toBe(true)
    expect(steps.indexOf(cache)).toBeLessThan(steps.indexOf(install))
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
        'verification-cache': { outputs: { key: 'a-key', 'cache-hit': 'false' } }
      }
    }
    const expression = save.if
      .replaceAll(
        'steps.verification-cache.outputs.cache-hit',
        'steps["verification-cache"].outputs["cache-hit"]'
      )
      .replaceAll('steps.verification-cache.outputs.key', 'steps["verification-cache"].outputs.key')
    expect(evaluate(expression, context)).toBe(expected)
    context.steps['verification-cache'].outputs.key = ''
    expect(evaluate(expression, context)).toBe(false)
    context.steps['verification-cache'].outputs.key = 'a-key'
    context.steps['verification-cache'].outputs['cache-hit'] = 'true'
    expect(evaluate(expression, context)).toBe(false)
    expect(save.uses).toBe('actions/cache/save@v5')
    expect(steps.indexOf(save)).toBeGreaterThan(steps.indexOf(install))
  })
})
