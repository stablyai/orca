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

// The checked bodies are the node test config's non-declaration roots, so no second list names them.
// Each is normalized to a repository path; phone bodies sit under mobile/, desktop ones under src/.
export function readNodeTestBodies(root = repoRoot) {
  const config = JSON.parse(fs.readFileSync(path.join(root, NODE_TEST_PROJECT), 'utf8'))
  const base = path.posix.dirname(NODE_TEST_PROJECT)
  return config.files
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'))
    .map((file) => path.posix.normalize(path.posix.join(base, toPosix(file))))
    .sort()
}

// Phone test roots, relative to mobile/, run under the phone's Bun role; the rest stay desktop-owned.
export function partitionNodeTestBodies(bodies) {
  const local = bodies.filter((file) => file.startsWith('mobile/') && /\.test\.tsx?$/.test(file))
  return {
    local: local.map((file) => file.slice('mobile/'.length)),
    external: bodies.filter((file) => !file.startsWith('mobile/'))
  }
}

// Declarations share one `@/` namespace; a phone declaration's `@/` path that a renderer file also
// occupies would silently resolve to the renderer, so name it instead.
export function findShadowedPhoneAliases(output) {
  const phone = path.join(output, 'mobile/src')
  const renderer = path.join(output, 'src/renderer/src')
  const problems = []
  const visit = (directory) => {
    for (const entry of fs.existsSync(directory)
      ? fs.readdirSync(directory, { withFileTypes: true })
      : []) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(file)
      } else if (file.endsWith('.d.ts')) {
        for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(/['"]@\/([^'"]+)['"]/g)) {
          if (
            ['.d.ts', '/index.d.ts'].some((suffix) =>
              fs.existsSync(path.join(renderer, `${spec}${suffix}`))
            )
          ) {
            problems.push(
              `phone declaration alias resolves to a renderer file: ${toPosix(path.relative(output, file))} imports @/${spec}`
            )
          }
        }
      }
    }
  }
  visit(phone)
  return problems
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

// Membership is the proof: every checked body, nothing else repository-owned that is not a declaration,
// and no RN/Expo global file. Bodies are repository paths. Returns the problems; empty is clean.
export function checkNodeTestProgram(files, { realRoot, expected }) {
  const prefix = `${toPosix(realRoot).replace(/\/$/, '')}/`
  const owned = files
    .filter((file) => file.startsWith(prefix) && !file.includes('/node_modules/'))
    .map((file) => file.slice(prefix.length))
  const problems = []
  for (const file of expected) {
    if (!owned.includes(file)) {
      problems.push(`checked body is missing from the program: ${file}`)
    }
  }
  for (const file of owned) {
    if (/\.tsx?$/.test(file) && !file.endsWith('.d.ts') && !expected.includes(file)) {
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
  const bodies = readNodeTestBodies(root)
  const { local: expected, external } = partitionNodeTestBodies(bodies)
  const output = ownOutputDirectory(root)
  try {
    const producers = []
    for (const project of DECLARATION_PROJECTS) {
      const pass = compile(project, [], root, run)
      producers.push(pass)
      if (!pass.ok) {
        return {
          ok: false,
          expected,
          external,
          programTestFiles: [],
          programExternalFiles: [],
          failures: [pass],
          problems: []
        }
      }
    }
    mirrorDeclarationInputs(producers, root, output)
    const check = compile(NODE_TEST_PROJECT, ['--noEmit'], root, run)
    const problems = [
      ...findShadowedPhoneAliases(output),
      ...checkNodeTestProgram(check.files, { realRoot: fs.realpathSync(root), expected: bodies })
    ]
    const prefix = `${toPosix(fs.realpathSync(root))}/`
    const inProgram = check.files
      .filter((file) => file.startsWith(prefix))
      .map((file) => file.slice(prefix.length))
    return {
      ok: check.ok && problems.length === 0,
      expected,
      external,
      programTestFiles: expected.filter((file) => inProgram.includes(`mobile/${file}`)),
      programExternalFiles: external.filter((file) => inProgram.includes(file)),
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
  console.log(
    `phone/host contract tests check: ${[...result.programTestFiles.map((file) => `mobile/${file}`), ...result.programExternalFiles].join(', ')}`
  )
}
