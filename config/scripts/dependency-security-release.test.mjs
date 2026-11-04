import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const release = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))
const audit = release.jobs['dependency-security']
const publish = release.jobs['publish-release']

function evaluate(expression, tag, result) {
  const needs = Object.fromEntries(publish.needs.map((job) => [job, { result: 'success' }]))
  needs.cut.outputs = { tag, should_release: 'true' }
  needs['dependency-security'] = { result }
  return runInNewContext(expression.replace(/needs\.([\w-]+)/g, 'needs["$1"]'), {
    needs,
    cancelled: () => false,
    contains: (value, part) => value.includes(part)
  })
}

it('audits stable releases without making publication wait for the scan', () => {
  expect(publish.needs).not.toContain('dependency-security')
  for (const tag of ['v1.5.0', 'v2.0.1']) {
    expect(evaluate(audit.if, tag, 'success')).toBe(true)
    for (const result of ['success', 'failure', 'cancelled', 'skipped', '', undefined]) {
      expect(evaluate(publish.if, tag, result)).toBe(true)
    }
  }
  for (const tag of ['v1.5.0-rc.1', 'v1.5.0-rc.1.perf']) {
    expect(evaluate(audit.if, tag, 'skipped')).toBe(false)
    expect(evaluate(publish.if, tag, 'skipped')).toBe(true)
  }
})

it('extracts release data while excluding executable package and Cargo configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'release audit data '))
  const source = join(root, 'source')
  const tooling = join(root, 'tooling')
  mkdirSync(source)
  mkdirSync(tooling)
  const data = [
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'mobile/pnpm-lock.yaml',
    'mobile/pnpm-workspace.yaml',
    'native/example/Cargo.toml',
    'native/example/Cargo.lock',
    'config/patches/example.patch',
    'mobile/patches/example.patch'
  ]
  const configuration = [
    'package.json',
    'mobile/package.json',
    '.gitattributes',
    '.npmrc',
    '.pnpmfile.cjs',
    'config/pnpmfile.cjs',
    'mobile/.npmrc',
    'mobile/.pnpmfile.cjs',
    '.cargo/config.toml',
    'native/.cargo/config.toml',
    'native/example/.cargo/config.toml',
    'native/example/rust-toolchain.toml',
    'native/example/build.rs'
  ]
  async function run(program, args, cwd, env = process.env) {
    const result = await runProcess({ program, args, cwd, env })
    expect(result.code, result.stderr).toBe(0)
  }
  try {
    for (const file of [...data, ...configuration]) {
      mkdirSync(dirname(join(source, file)), { recursive: true })
      writeFileSync(
        join(source, file),
        file === '.gitattributes'
          ? '*.yaml export-ignore\n*.patch export-subst\n'
          : `${file} contents`
      )
    }
    await run('git', ['init', '--quiet'], source)
    await run('git', ['add', '.'], source)
    await run(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--quiet',
        '-m',
        'fixture'
      ],
      source
    )
    await run('git', ['init', '--quiet'], tooling)
    await run('git', ['remote', 'add', 'origin', source], tooling)
    const action = parse(
      readFileSync('.github/actions/prepare-dependency-audit/action.yml', 'utf8')
    )
    await run('bash', ['-c', action.runs.steps[0].run], tooling, {
      ...process.env,
      RELEASE_REF: 'HEAD'
    })
    for (const file of data) {
      expect(readFileSync(join(tooling, 'candidate', file), 'utf8')).toBe(`${file} contents`)
    }
    for (const file of configuration) {
      expect(existsSync(join(tooling, 'candidate', file)), file).toBe(false)
    }
    rmSync(join(tooling, 'candidate'), { recursive: true })
    await run('git', ['rm', '--quiet', 'pnpm-workspace.yaml'], source)
    await run(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--quiet',
        '-m',
        'missing workspace'
      ],
      source
    )
    const missing = await runProcess({
      program: 'bash',
      args: ['-c', action.runs.steps[0].run],
      cwd: tooling,
      env: { ...process.env, RELEASE_REF: 'HEAD' }
    })
    expect(missing.code).not.toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
