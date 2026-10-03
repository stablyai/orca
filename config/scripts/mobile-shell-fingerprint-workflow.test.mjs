import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/mobile-shell-fingerprint.yml', 'utf8'))
const steps = workflow.jobs['shell-fingerprint'].steps
const scopeScript = steps.find((step) => step.id === 'scope').run
const matcher = /shell_paths=\([\s\S]*?\n\}\n/.exec(scopeScript)?.[0]

function bashShellPaths() {
  const list = /shell_paths=\(\n([\s\S]*?)\n\s*\)/.exec(scopeScript)[1]
  return list
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.replace(/^'(.*)'$/, '$1'))
}

describe('mobile shell fingerprint workflow', () => {
  // A push that reverts the last shell edit must still run, or the label outlives the change.
  it('runs on every pull request and filters paths only on main', () => {
    expect(workflow.on.pull_request.paths).toBeUndefined()
    expect(workflow.on.push.paths.length).toBeGreaterThan(0)
  })

  it('matches pull requests against the same shell paths main filters on', () => {
    expect(bashShellPaths()).toEqual(workflow.on.push.paths)
  })

  // Git quotes non-ASCII paths by default, which would hide `mobile/…` from every pattern.
  it.skipIf(process.platform === 'win32')(
    'detects a PR touching only a non-ASCII shell path',
    () => {
      const repo = mkdtempSync(join(tmpdir(), 'shell-scope-'))
      try {
        const git = (...args) =>
          spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo })
        git('init', '-q')
        writeFileSync(join(repo, 'README.md'), 'base\n')
        git('add', '.')
        git('commit', '-qm', 'base')
        mkdirSync(join(repo, 'mobile'))
        writeFileSync(join(repo, 'mobile', 'caf\u00e9.ts'), 'export {}\n')
        git('add', '.')
        git('commit', '-qm', 'head')
        const output = join(repo, 'github-output')
        const result = spawnSync('bash', ['-c', scopeScript], {
          cwd: repo,
          encoding: 'utf8',
          env: { ...process.env, GITHUB_OUTPUT: output, RUNNER_TEMP: repo }
        })
        expect(result.status, result.stderr).toBe(0)
        expect(readFileSync(output, 'utf8')).toBe('shell_inputs=true\n')
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')('matches files the way the paths filter does', () => {
    expect(matcher).toBeDefined()
    const files = [
      'mobile/src/app.ts',
      'src/shared/protocol-version.ts',
      'mobile/rpc-foundation/goldens/a.json',
      'mobile/src/app.test.ts',
      'src/renderer/a.ts',
      '.github/workflows/mobile-shell-fingerprint.yml'
    ]
    const script = `${matcher}\nfor f in ${files.map((file) => `'${file}'`).join(' ')}; do if touches_shell "$f"; then echo "$f"; fi; done`
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual([
      'mobile/src/app.ts',
      'src/shared/protocol-version.ts',
      '.github/workflows/mobile-shell-fingerprint.yml'
    ])
  })
})
