#!/usr/bin/env node
// Runs tests/e2e/terminal-layout-parity.spec.ts against a base and a head build and diffs the
// captured layouts and saved sessions. Usage: tests/e2e/AGENTS.md.

import { build } from 'esbuild'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { runProcessSync } from '@orca/process-host'
import { describeProcessFailure } from './process-failure-message.mjs'
const repoRoot = resolve(import.meta.dirname, '../..')
const BUILD_STAMP = join('out', '.terminal-layout-parity-build')

// Bundle TypeScript parity modules so plain Node does not need a loader.
async function importParityModules() {
  const temporary = mkdtempSync(join(tmpdir(), 'orca-layout-parity-'))
  try {
    const outfile = join(temporary, 'parity.mjs')
    await build({
      stdin: {
        contents: ['snapshot', 'declared-differences']
          .map(
            (name) =>
              `export * from ${JSON.stringify(join(repoRoot, 'tests', 'e2e', `terminal-layout-parity-${name}.ts`))}`
          )
          .join('\n'),
        resolveDir: repoRoot,
        sourcefile: 'terminal-layout-parity-entry.ts'
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      logLevel: 'silent'
    })
    return await import(pathToFileURL(outfile).href)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

const {
  TERMINAL_LAYOUT_PARITY_OUT_ENV,
  TERMINAL_LAYOUT_PARITY_DECLARED_DIFFERENCES,
  TERMINAL_LAYOUT_PARITY_UNSTABLE_ON_MAIN,
  compareParityCaptures,
  isParityClean
} = await importParityModules()

// `pnpm run <script> -- --base x` forwards the `--`, which would turn every option positional.
const rawArgs = process.argv.slice(2)
const { values } = parseArgs({
  args: rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs,
  options: {
    base: { type: 'string' },
    head: { type: 'string' },
    'work-dir': { type: 'string' },
    out: { type: 'string' },
    grep: { type: 'string', short: 'g' }
  }
})

function run(program, args, cwd, env = process.env, { allowFailure = false } = {}) {
  const result = runProcessSync({ program, args, cwd, env, stdio: 'inherit', timeoutMs: null })
  if (result.code !== 0 && !allowFailure) {
    throw new Error(
      `${program} ${args.join(' ')} failed in ${cwd}: ${describeProcessFailure(result)}`
    )
  }
  return result.code === 0
}

function git(args) {
  const result = runProcessSync({ program: 'git', args, cwd: repoRoot })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${describeProcessFailure(result)}`)
  }
  return result.stdout.trim()
}

// npm_execpath is pnpm's JS entry (run under node), a native pnpm binary (corepack), or unset.
function pnpm(args, cwd, env = process.env) {
  const entry = process.env.npm_execpath
  if (entry && /\.[cm]?js$/i.test(entry)) {
    run(process.execPath, [entry, ...args], cwd, env)
  } else if (entry && /pnpm/i.test(basename(entry)) && existsSync(entry)) {
    run(entry, args, cwd, env)
  } else {
    run('pnpm', args, cwd, env)
  }
}

/** A detached worktree per commit, installed and built once; a failed build throws before stamping. */
function prepareCheckout(sha, workDir) {
  const tree = join(workDir, sha.slice(0, 12))
  if (!existsSync(tree)) {
    git(['worktree', 'add', '--detach', tree, sha])
  }
  if (readStamp(tree) !== sha) {
    pnpm(['install', '--frozen-lockfile', '--prefer-offline'], tree)
    // Mirrors tests/e2e/global-setup.ts's build, so SKIP_BUILD later launches exactly this output.
    pnpm(['exec', 'electron-vite', 'build', '--mode', 'e2e'], tree, {
      ...process.env,
      VITE_EXPOSE_STORE: 'true'
    })
    pnpm(['run', 'build:cli'], tree)
    writeFileSync(join(tree, BUILD_STAMP), `${sha}\n`)
  }
  return { tree, skipBuild: true }
}

function readStamp(tree) {
  const stamp = join(tree, BUILD_STAMP)
  return existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : null
}

/** Head's spec and helpers drive the side's build: cwd selects which out/ the helpers launch. */
function captureSide(label, side, outRoot) {
  const outDir = join(outRoot, label)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  run(
    process.execPath,
    ['config/scripts/ensure-native-runtime.mjs', '--runtime=electron'],
    side.tree
  )
  // A failed scenario still compares (as missing) but fails the run, so two failures cannot pass.
  const passed = run(
    process.execPath,
    [
      join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js'),
      'test',
      'terminal-layout-parity.spec.ts',
      '--config',
      join(repoRoot, 'tests', 'playwright.config.ts'),
      '--project',
      'electron-headless',
      '--workers=1',
      ...(values.grep ? ['--grep', values.grep] : [])
    ],
    side.tree,
    {
      ...process.env,
      ORCA_BACKGROUND_LAUNCH: '1',
      [TERMINAL_LAYOUT_PARITY_OUT_ENV]: outDir,
      // The working tree builds in Playwright's global setup; checkouts were built above.
      ...(side.skipBuild ? { SKIP_BUILD: '1' } : {})
    },
    { allowFailure: true }
  )
  return { outDir, passed }
}

function loadCaptures(outDir) {
  return new Map(
    readdirSync(outDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const capture = JSON.parse(readFileSync(join(outDir, name), 'utf8'))
        return [capture.scenario, capture]
      })
  )
}

function main() {
  const workDir = resolve(values['work-dir'] ?? join(repoRoot, '.tmp', 'terminal-layout-parity'))
  const outRoot = resolve(values.out ?? join(workDir, 'captures'))
  mkdirSync(workDir, { recursive: true })
  const baseSha = git([
    'rev-parse',
    '--verify',
    `${values.base ?? git(['merge-base', 'origin/main', 'HEAD'])}^{commit}`
  ])
  const base = { sha: baseSha, ...prepareCheckout(baseSha, workDir) }
  // No --head: the current checkout, including uncommitted edits, is the head.
  const headSha = values.head ? git(['rev-parse', '--verify', `${values.head}^{commit}`]) : null
  const head = headSha
    ? headSha === baseSha
      ? base
      : { sha: headSha, ...prepareCheckout(headSha, workDir) }
    : { sha: null, tree: repoRoot, skipBuild: false }

  const baseRun = captureSide('base', base, outRoot)
  const headRun = captureSide('head', head, outRoot)
  const baseCaptures = loadCaptures(baseRun.outDir)
  const report = compareParityCaptures(
    baseCaptures,
    loadCaptures(headRun.outDir),
    TERMINAL_LAYOUT_PARITY_DECLARED_DIFFERENCES,
    TERMINAL_LAYOUT_PARITY_UNSTABLE_ON_MAIN
  )
  writeFileSync(join(outRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[layout-parity] base ${baseSha} vs head ${headSha ?? 'working tree'}`)
  for (const difference of report.declared) {
    console.log(
      `[layout-parity] declared (${difference.bugId}) ${difference.scenario}${difference.path}`
    )
  }
  for (const difference of report.unstableOnMain) {
    console.log(`[layout-parity] unstable on main ${difference.scenario}${difference.path}`)
  }
  for (const difference of report.undeclared) {
    console.log(
      `[layout-parity] DIFFERENT ${difference.scenario}${difference.path}: ${JSON.stringify(difference.base)} -> ${JSON.stringify(difference.head)}`
    )
  }
  for (const declaration of report.unusedDeclarations) {
    console.log(`[layout-parity] UNOBSERVED fix ${declaration.bugId} in ${declaration.scenario}`)
  }
  const clean = isParityClean(report) && baseRun.passed && headRun.passed && baseCaptures.size > 0
  if (!baseRun.passed || !headRun.passed) {
    console.log(
      `[layout-parity] scenario run failed: base=${baseRun.passed} head=${headRun.passed}`
    )
  }
  console.log(`[layout-parity] ${clean ? 'PASS' : 'FAIL'}; report: ${join(outRoot, 'report.json')}`)
  process.exit(clean ? 0 : 1)
}

main()
