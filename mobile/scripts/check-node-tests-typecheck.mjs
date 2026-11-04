import { runProcessSync } from '@orca/process-host'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveProjectCompilerInfo } from '../../config/scripts/run-typecheck-projects-in-parallel.mjs'

// Phone tests that drive real desktop sources cannot join the RN test program: RN's global timers
// and Expo's process.env augmentation break the desktop graph. Each source graph emits genuine
// declarations under its own existing compiler options, and one strict Node program checks the test
// bodies against those declarations. Vitest still runs the tests against the original sources.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
export const NODE_TEST_PROJECT = 'mobile/tsconfig.test.node.json'
// Mobile first, host second: the host owner rewrites every root src declaration, shared types included.
export const DECLARATION_PROJECTS = [
  'mobile/tsconfig.test.mobile-declarations.json',
  'config/tsconfig.test.mobile-host-declarations.json'
]
export const DECLARATION_OUTPUT = 'mobile/node_modules/.cache/phone-host-contract-types'
const DIAGNOSTIC = /error TS\d+:/
// Either file in the final program means the public declaration closure reached RN/Expo again.
const LEAKED_NATIVE_GLOBALS = [
  /\/react-native\/src\/types\/globals\.d\.ts$/,
  /\/expo\/types\/metro-require\.d\.ts$/
]
const toPosix = (filePath) => filePath.replaceAll('\\', '/')

// The two test bodies are the roots of the node test config, so no second list names them.
export function readNodeTestRoots(root = repoRoot) {
  const config = JSON.parse(fs.readFileSync(path.join(root, NODE_TEST_PROJECT), 'utf8'))
  return config.files.filter((file) => /\.test\.tsx?$/.test(file)).sort()
}

export function parseCompilerPass(output, code) {
  const lines = output.split('\n').map((line) => line.trim())
  const diagnostics = lines.filter((line) => DIAGNOSTIC.test(line))
  const files = lines
    .filter((line) => /\.(?:tsx?|json)$/.test(line) && !DIAGNOSTIC.test(line))
    .filter((line) => path.isAbsolute(line))
    .map(toPosix)
  return { ok: code === 0 && diagnostics.length === 0, code, diagnostics, files }
}

// Membership is the proof: both bodies, nothing else repository-owned that is not a declaration,
// and no RN/Expo global file. Returns the problems; an empty list is a clean program.
export function checkNodeTestProgram(files, { realRoot, expected }) {
  const prefix = `${toPosix(realRoot).replace(/\/$/, '')}/`
  const owned = files
    .filter((file) => file.startsWith(prefix) && !file.includes('/node_modules/'))
    .map((file) => file.slice(prefix.length))
  const expectedPaths = expected.map((file) => `mobile/${file}`)
  const problems = []
  for (const file of expectedPaths) {
    if (!owned.includes(file)) {
      problems.push(`checked test body is missing from the program: ${file}`)
    }
  }
  for (const file of owned) {
    if (/\.tsx?$/.test(file) && !file.endsWith('.d.ts') && !expectedPaths.includes(file)) {
      problems.push(`implementation source re-entered the test program: ${file}`)
    }
  }
  for (const file of files) {
    if (LEAKED_NATIVE_GLOBALS.some((pattern) => pattern.test(file))) {
      problems.push(`native global declarations leaked into the test program: ${file}`)
    }
  }
  return problems
}

function compile(project, args, root, run) {
  const { program } = resolveProjectCompilerInfo(project, root)
  const result = run({
    program: process.execPath,
    args: [
      program,
      '-p',
      path.join(root, project),
      '--pretty',
      'false',
      '--listFiles',
      '--checkers',
      '8',
      ...args
    ],
    cwd: root,
    timeoutMs: null,
    maxOutputBytes: 64 * 1024 * 1024
  })
  return {
    project,
    ...parseCompilerPass(`${result.stdout ?? ''}${result.stderr ?? ''}`, result.code)
  }
}

function ownOutputDirectory(root) {
  const output = path.join(root, DECLARATION_OUTPUT)
  const parent = path.dirname(output)
  fs.mkdirSync(parent, { recursive: true })
  const realRoot = fs.realpathSync(root)
  const realParent = fs.realpathSync(parent)
  if (!`${toPosix(realParent)}/`.startsWith(`${toPosix(realRoot)}/`)) {
    throw new Error(`Declaration output escapes the repository: ${realParent}`)
  }
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) {
    throw new Error(`Declaration output is an unexpected symlink: ${output}`)
  }
  fs.rmSync(output, { recursive: true, force: true })
  fs.mkdirSync(output)
  return output
}

// Emitted declarations keep relative imports of original .d.ts/JSON inputs; mirror exactly those
// the producers actually compiled, byte for byte, beside them.
function mirrorDeclarationInputs(passes, root, output) {
  const prefix = `${toPosix(fs.realpathSync(root))}/`
  for (const file of new Set(passes.flatMap((pass) => pass.files))) {
    if (
      !file.startsWith(prefix) ||
      file.includes('/node_modules/') ||
      !(file.endsWith('.d.ts') || file.endsWith('.json'))
    ) {
      continue
    }
    const target = path.join(output, file.slice(prefix.length))
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(file, target)
    }
  }
}

// Sequential: two declaration producers, then the strict check of the test bodies.
export function runNodeTestsTypecheck({ root = repoRoot, run = runProcessSync } = {}) {
  const expected = readNodeTestRoots(root)
  const output = ownOutputDirectory(root)
  try {
    const producers = []
    for (const project of DECLARATION_PROJECTS) {
      const pass = compile(project, [], root, run)
      producers.push(pass)
      if (!pass.ok) {
        return { ok: false, expected, programTestFiles: [], failures: [pass], problems: [] }
      }
    }
    mirrorDeclarationInputs(producers, root, output)
    const check = compile(NODE_TEST_PROJECT, ['--noEmit'], root, run)
    const problems = checkNodeTestProgram(check.files, {
      realRoot: fs.realpathSync(root),
      expected
    })
    const prefix = `${toPosix(fs.realpathSync(root))}/mobile/`
    return {
      ok: check.ok && problems.length === 0,
      expected,
      programTestFiles: check.files
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length))
        .filter((file) => expected.includes(file)),
      failures: check.ok ? [] : [check],
      problems
    }
  } finally {
    fs.rmSync(output, { recursive: true, force: true })
  }
}

export function printNodeTestsFailure(result) {
  for (const failure of result.failures) {
    console.error(`::error::${failure.project} failed (exit ${failure.code})`)
    for (const diagnostic of failure.diagnostics) {
      console.error(diagnostic)
    }
  }
  for (const problem of result.problems) {
    console.error(`::error::${problem}`)
  }
  console.error('')
  console.error('  Phone/host contract tests are checked through emitted declarations.')
  console.error('  Reproduce with:  node scripts/check-node-tests-typecheck.mjs')
  console.error('')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = runNodeTestsTypecheck()
  if (!result.ok) {
    printNodeTestsFailure(result)
    process.exit(1)
  }
  console.log(`phone/host contract tests check: ${result.programTestFiles.join(', ')}`)
}
