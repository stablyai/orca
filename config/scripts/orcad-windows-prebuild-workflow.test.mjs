import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { runProcessSync } from './script-child-process.mjs'

const workflow = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))
const steps = workflow.jobs.persistence.steps
const prepare = steps.find((step) => step.id === 'orcad-prebuild')
const action = parse(readFileSync('.github/actions/prepare-orcad-prebuilds/action.yml', 'utf8'))
const actionSteps = action.runs.steps
const identity = actionSteps.find((step) => step.id === 'orcad-prebuild-cache-identity')
const restore = actionSteps.find((step) => step.id === 'orcad-prebuild-cache-restore')
const build = actionSteps.find((step) => step.name?.startsWith('Build and smoke this runner'))
const save = steps.find((step) => step.uses === 'actions/cache/save@v5')

function evaluate(expression, context) {
  return runInNewContext(
    expression
      .replaceAll('steps.orcad-prebuild-cache-identity', 'steps["orcad-prebuild-cache-identity"]')
      .replaceAll('steps.orcad-prebuild', 'steps["orcad-prebuild"]')
      .replace(
        /\.(resolve-windows-cache|restore-windows-cache|cache-identity-outcome|cache-key)\b/g,
        (_match, name) => `["${name}"]`
      ),
    context
  )
}

function actionContext(ctx, caller = prepare) {
  return {
    ...ctx,
    inputs: Object.fromEntries(
      Object.entries(caller.with).map(([key, value]) => [
        key,
        value.startsWith('${{') ? String(evaluate(value.slice(3, -2).trim(), ctx)) : value
      ])
    )
  }
}

function setIdentity(ctx, outcome, key = 'exact-key') {
  ctx.steps['orcad-prebuild-cache-identity'] = { outcome, outputs: { key } }
  ctx.steps['orcad-prebuild'].outputs = { 'cache-identity-outcome': outcome, 'cache-key': key }
}

function context(os, arch, event, ref, template = false) {
  return {
    runner: { os, arch },
    github: { event_name: event, ref },
    inputs: { build_template: template, ref: '' },
    steps: {
      'orcad-prebuild-cache-identity': { outcome: 'success', outputs: { key: 'exact-key' } },
      'orcad-prebuild': {
        outputs: { 'cache-identity-outcome': 'success', 'cache-key': 'exact-key' }
      }
    },
    success: () => true,
    fromJSON: JSON.parse,
    contains: (values, value) => values.includes(value)
  }
}

describe('Windows server prebuild cache workflow', () => {
  it.each([
    ['pull_request', 'refs/pull/1/merge', false, true, false],
    ['push', 'refs/heads/main', false, true, true],
    ['schedule', 'refs/heads/main', false, false, true],
    ['workflow_dispatch', 'refs/heads/main', false, false, true],
    ['workflow_call', 'refs/heads/main', false, false, false],
    ['push', 'refs/tags/v1', false, false, false],
    ['workflow_dispatch', 'refs/heads/feature', false, false, false],
    ['pull_request', 'refs/pull/1/merge', true, false, false],
    ['workflow_dispatch', 'refs/heads/main', true, false, false]
  ])('%s %s template=%s restores=%s saves=%s', (event, ref, template, reads, writes) => {
    for (const [os, arch] of [
      ['Windows', 'X64'],
      ['Windows', 'ARM64'],
      ['Windows', 'X86'],
      ['Linux', 'X64'],
      ['macOS', 'ARM64']
    ]) {
      const ctx = context(os, arch, event, ref, template)
      const windows = os === 'Windows' && ['X64', 'ARM64'].includes(arch)
      const resolves = evaluate(identity.if, actionContext(ctx))
      expect(resolves).toBe(windows && (reads || writes))
      setIdentity(ctx, resolves ? 'success' : 'skipped')
      expect(evaluate(restore.if, actionContext(ctx))).toBe(windows && reads)
      expect(evaluate(save.if, ctx)).toBe(windows && writes)
      ctx.success = () => false
      expect(evaluate(save.if, ctx)).toBe(false)
    }
  })

  it('treats missing identities and explicit release refs as fresh builds', () => {
    for (const event of ['pull_request', 'push']) {
      const ctx = context('Windows', 'X64', event, 'refs/heads/main')
      for (const outcome of ['failure', 'skipped']) {
        setIdentity(ctx, outcome)
        expect(evaluate(restore.if, actionContext(ctx))).toBe(false)
        expect(evaluate(save.if, ctx)).toBe(false)
      }
      setIdentity(ctx, 'success', '')
      expect(evaluate(restore.if, actionContext(ctx))).toBe(false)
      expect(evaluate(save.if, ctx)).toBe(false)
      ctx.inputs.ref = 'refs/tags/v1'
      expect(evaluate(identity.if, actionContext(ctx))).toBe(false)
      expect(evaluate(save.if, ctx)).toBe(false)
    }
  })

  it.each(['push', 'schedule', 'workflow_dispatch', 'pull_request'])(
    'keeps reusable release/template calls fresh under the inherited %s event',
    (event) => {
      for (const inputs of [
        { build_template: true, ref: '' },
        { build_template: false, ref: 'refs/tags/v1' },
        { build_template: true, ref: 'refs/tags/v1' }
      ]) {
        const ctx = context('Windows', 'X64', event, 'refs/heads/main')
        ctx.inputs = inputs
        expect(evaluate(identity.if, actionContext(ctx))).toBe(false)
        expect(evaluate(save.if, ctx)).toBe(false)
        setIdentity(ctx, 'skipped')
        expect(evaluate(restore.if, actionContext(ctx))).toBe(false)
      }
    }
  )

  it('restores only the exact key and saves after every qualification gate', () => {
    expect(identity['continue-on-error']).toBe(true)
    expect(identity.run).toBe('node config/scripts/orcad-windows-prebuild-cache.mjs --fingerprint')
    expect(restore.uses).toBe('actions/cache/restore@v5')
    expect(restore['continue-on-error']).toBe(true)
    expect(restore.with['restore-keys']).toBeUndefined()
    expect(action.outputs['cache-path'].value).toBe(restore.with.path)
    expect(action.outputs['cache-key'].value).toBe(restore.with.key)
    expect(save.with.path).toBe('${{ steps.orcad-prebuild.outputs.cache-path }}')
    expect(save.with.key).toBe('${{ steps.orcad-prebuild.outputs.cache-key }}')
    expect(prepare.uses).toBe('./.github/actions/prepare-orcad-prebuilds')
    expect(restore.with.key).toBe('${{ steps.orcad-prebuild-cache-identity.outputs.key }}')
    expect(restore.with.path).toBe('${{ steps.orcad-prebuild-cache-identity.outputs.path }}')
    expect(actionSteps.indexOf(restore)).toBeLessThan(actionSteps.indexOf(build))
    expect(save['continue-on-error']).toBe(true)
    expect(steps.indexOf(save)).toBeGreaterThan(steps.indexOf(prepare))
    expect(actionSteps.some((step) => step.uses === 'actions/cache/save@v5')).toBe(false)
    expect(build.if).toBeUndefined()
    expect(build['continue-on-error']).toBeUndefined()
    for (const gate of steps.filter((step) =>
      /require-slots|--smoke|pnpm build:orcad$|test:node-server|--orcad-smoke-load-check/.test(
        step.run ?? ''
      )
    )) {
      expect(steps.indexOf(save)).toBeGreaterThan(steps.indexOf(gate))
      expect(gate['continue-on-error']).toBeUndefined()
    }
    for (const lane of [
      'linux_glibc_floor',
      'linux_glibc217_compat',
      'linux_musl',
      'desktop_template'
    ]) {
      expect(
        workflow.jobs[lane].steps.some((step) => step.id?.startsWith('orcad-prebuild-cache'))
      ).toBe(false)
    }
  })
})

describe('SSH Windows consumers of qualified server slots', () => {
  const sshWorkflow = parse(readFileSync('.github/workflows/ssh-windows-hosts.yml', 'utf8'))
  const sshSteps = sshWorkflow.jobs.hosts.steps
  const sshPrepare = sshSteps.find((step) => step.uses === prepare.uses)

  it.each(['pull_request', 'workflow_dispatch'])(
    'restores only PR slots and keeps manual %s qualification fresh',
    (event) => {
      for (const arch of ['X64', 'ARM64']) {
        const ctx = context('Windows', arch, event, 'refs/heads/main')
        expect(evaluate(identity.if, actionContext(ctx, sshPrepare))).toBe(event === 'pull_request')
        expect(evaluate(restore.if, actionContext(ctx, sshPrepare))).toBe(event === 'pull_request')
      }
      expect(sshSteps.some((step) => step.uses === 'actions/cache/save@v5')).toBe(false)
    }
  )

  it('keeps both architectures, both sshd versions and the existing build order', () => {
    expect(
      sshWorkflow.jobs.hosts.strategy.matrix.include.map(({ arch, server }) => [arch, server])
    ).toEqual([
      ['x64', 'inbox'],
      ['x64', 'preview'],
      ['arm64', 'inbox'],
      ['arm64', 'preview']
    ])
    const addon = sshSteps.findIndex((step) =>
      step.run?.includes('build-windows-process-tree-relay-addon.mjs')
    )
    const template = sshSteps.findIndex((step) => step.run?.includes('build-orcad-template.mjs'))
    const hosts = sshSteps.findIndex((step) => step.name?.startsWith('Run the Windows host cells'))
    expect(addon).toBeLessThan(sshSteps.indexOf(sshPrepare))
    expect(sshSteps.indexOf(sshPrepare)).toBeLessThan(template)
    expect(template).toBeLessThan(hosts)
    expect(sshSteps[template].env.ORCA_REQUIRE_RELAY_NATIVE_ADDONS).toBe('${{ matrix.arch }}')
    expect(sshSteps[template].run).toContain('--require-slots "win32-${{ matrix.arch }}"')
    expect(sshSteps[hosts].run).toContain("@('pinned-cmd','pinned-powershell','legacy-opt-out')")
    for (const workflowPaths of [
      workflow.on.pull_request.paths,
      sshWorkflow.on.pull_request.paths
    ]) {
      expect(workflowPaths).toContain('.github/actions/prepare-orcad-prebuilds/**')
    }
    expect(sshWorkflow.on.pull_request.paths).toContain(
      'config/scripts/orcad-windows-prebuild-cache.mjs'
    )
  })
})

const commandMocks = `
node() {
  echo "node $*" >> "$COMMAND_LOG"
  case "$*" in
    *--validate)
      IFS= read -r verdict < out/orcad-prebuilds/manifest.json
      [ "$verdict" = valid ] ;;
    *--print-slot) echo win32-x64 ;;
    *) return 41 ;;
  esac
}
pnpm() {
  echo "pnpm $*" >> "$COMMAND_LOG"
  if [ "$*" = build:orcad-prebuilds ]; then
    if [ "$RUNNER_OS" = Windows ]; then
      [ ! -e out/orcad-prebuilds/old-payload ] || return 42
    fi
    [ "$COMPILE_STATUS" = 0 ] || return "$COMPILE_STATUS"
    mkdir -p out/orcad-prebuilds
    echo valid > out/orcad-prebuilds/manifest.json
  fi
}
`

function runBuild({ os = 'Windows', hit = '', outcome = '', manifest = 'valid', compile = '0' }) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-windows-prebuild-workflow-'))
  const log = join(directory, 'commands')
  try {
    mkdirSync(join(directory, 'out/orcad-prebuilds'), { recursive: true })
    writeFileSync(join(directory, 'out/orcad-prebuilds/manifest.json'), `${manifest}\n`)
    writeFileSync(join(directory, 'out/orcad-prebuilds/old-payload'), 'old payload')
    writeFileSync(join(directory, 'out/preserve-other-output'), 'keep')
    writeFileSync(log, '')
    const result = runProcessSync({
      program: 'bash',
      args: ['-e', '-o', 'pipefail', '-c', `${commandMocks}\n${build.run}`],
      cwd: directory,
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        RUNNER_OS: os,
        WINDOWS_PREBUILD_CACHE_HIT: hit,
        WINDOWS_PREBUILD_CACHE_RESTORE_OUTCOME: outcome,
        COMMAND_LOG: log,
        COMPILE_STATUS: compile
      },
      timeoutMs: 10_000
    })
    expect(readFileSync(join(directory, 'out/preserve-other-output'), 'utf8')).toBe('keep')
    return { result, commands: readFileSync(log, 'utf8').trim().split('\n') }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe.skipIf(process.platform === 'win32')('Windows prebuild Bash fallback', () => {
  it.each([
    ['warm valid', 'true', 'success', 'valid', false, true],
    ['invalid manifest', 'true', 'success', '{broken', true, true],
    ['restore error', 'true', 'failure', 'valid', true, false],
    ['cache miss', 'false', 'success', 'valid', true, false],
    ['missing identity', '', '', 'valid', true, false]
  ])('%s retains fresh gates', (_name, hit, outcome, manifest, compiles, validates) => {
    const { result, commands } = runBuild({ hit, outcome, manifest })
    expect(result.code).toBe(0)
    expect(commands.includes('pnpm build:orcad-prebuilds')).toBe(compiles)
    expect(
      commands.includes('node config/scripts/orcad-windows-prebuild-cache.mjs --validate')
    ).toBe(validates)
    expect(commands.slice(-3)).toEqual([
      'node config/scripts/build-orcad-prebuilds.mjs --print-slot',
      'pnpm build:orcad-prebuilds --require-slots win32-x64',
      'pnpm build:orcad-prebuilds --smoke'
    ])
  })

  it.each(['Linux', 'macOS'])('%s keeps its fresh compilation and other output', (os) => {
    const { result, commands } = runBuild({ os, hit: 'true', outcome: 'success' })
    expect(result.code).toBe(0)
    expect(commands[0]).toBe('pnpm build:orcad-prebuilds')
  })

  it('stops qualification when fallback compilation fails', () => {
    const { result, commands } = runBuild({
      hit: 'true',
      outcome: 'success',
      manifest: '{broken',
      compile: '9'
    })
    expect(result.code).toBe(9)
    expect(commands.at(-1)).toBe('pnpm build:orcad-prebuilds')
  })
})
