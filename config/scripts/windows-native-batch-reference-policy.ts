import ts from 'typescript-api'
import {
  collectModuleSpecifiers,
  literalString,
  propertyName
} from './static-module-specifiers.mjs'
import { hasNodeModulesBinSpawn } from './windows-bin-spawn-predicate.mjs'

const references = new Map([
  [
    'config/scripts/node-server-change-scope.mjs',
    'config/scripts/capture-windows-native-environment.cmd'
  ],
  [
    'config/scripts/pr-code-change-scope.mjs',
    'config/scripts/capture-windows-native-environment.cmd'
  ],
  [
    'config/scripts/orcad-windows-prebuild-cache.mjs',
    'config/scripts/capture-windows-native-environment.cmd'
  ],
  [
    'config/scripts/windows-native-toolchain-routing.test.mjs',
    'config/scripts/capture-windows-native-environment.cmd'
  ],
  [
    'config/scripts/windows-native-benchmark-observer.mjs',
    'capture-windows-native-environment.cmd'
  ],
  [
    'config/scripts/initialize-windows-native-toolchain.mjs',
    'capture-windows-native-environment.cmd'
  ],
  [
    'config/scripts/benchmark-windows-native-preparation.mjs',
    'config/scripts/capture-windows-native-environment.cmd'
  ]
])
const executors = new Map([
  ['config/scripts/initialize-windows-native-toolchain.mjs', 'runProcessSync'],
  ['config/scripts/benchmark-windows-native-preparation.mjs', 'runProcess']
])
const initializer = 'config/scripts/initialize-windows-native-toolchain.mjs'
const observer = 'config/scripts/windows-native-benchmark-observer.mjs'
const rawProcessMethods = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork'
])
const processHostMethods = new Set(['runProcess', 'runProcessSync', 'spawnProcess'])

function callName(node: ts.Expression): string {
  return ts.isIdentifier(node) ? node.text : (propertyName(node) ?? '')
}

function isDeveloperCommandMetadata(node: ts.StringLiteral): boolean {
  const call = node.parent
  const declaration = call.parent
  return (
    ts.isCallExpression(call) &&
    callName(call.expression) === 'join' &&
    call.arguments.at(-1) === node &&
    ts.isVariableDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === 'devcmd'
  )
}

function isDeveloperCommandUse(node: ts.Identifier): boolean {
  const parent = node.parent
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isCallExpression(parent) &&
      callName(parent.expression) === 'existsSync' &&
      parent.arguments[0] === node) ||
    (ts.isPropertyAssignment(parent) &&
      parent.initializer === node &&
      ts.isIdentifier(parent.name) &&
      parent.name.text === 'ORCA_WINDOWS_VSDEVCMD')
  )
}

function isProcessHostCapture(node: ts.StringLiteral, importedMethods: Set<string>): boolean {
  const path = node.parent
  if (
    !ts.isCallExpression(path) ||
    callName(path.expression) !== 'join' ||
    path.arguments.length !== 2 ||
    path.arguments[0].getText() !== 'import.meta.dirname' ||
    path.arguments[1] !== node
  ) {
    return false
  }
  const program = path.parent
  if (
    !ts.isPropertyAssignment(program) ||
    !ts.isIdentifier(program.name) ||
    program.name.text !== 'program'
  ) {
    return false
  }
  const spec = program.parent
  const call = spec.parent
  return (
    ts.isObjectLiteralExpression(spec) &&
    ts.isCallExpression(call) &&
    call.arguments[0] === spec &&
    ts.isIdentifier(call.expression) &&
    importedMethods.has(call.expression.text)
  )
}

export function hasWindowsNativeBatchReferenceViolation(
  relativePath: string,
  contents: string,
  literals: readonly string[]
): boolean {
  const capture = references.get(relativePath)
  if (!capture) {
    return literals.length > 0
  }
  if (
    literals.some(
      (literal) =>
        literal !== capture && !(relativePath === initializer && literal === 'VsDevCmd.bat')
    )
  ) {
    return true
  }
  const modules = collectModuleSpecifiers(relativePath, contents)
  if (modules.some((module) => module === 'child_process' || module === 'node:child_process')) {
    return true
  }
  const expectedMethod = executors.get(relativePath)
  if ((expectedMethod || relativePath === observer) && !modules.includes('@orca/process-host')) {
    return true
  }
  if (!expectedMethod && relativePath !== observer && modules.includes('@orca/process-host')) {
    return true
  }
  const source = ts.createSourceFile(relativePath, contents, ts.ScriptTarget.Latest, true)
  const importedMethods = new Set<string>()
  const calls: ts.CallExpression[] = []
  const programs: ts.Expression[] = []
  const captureReferences: ts.StringLiteral[] = []
  let violation = false
  let developerCommandDeclarations = 0
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@orca/process-host'
    ) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          if ((binding.propertyName ?? binding.name).text === expectedMethod) {
            importedMethods.add(binding.name.text)
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      calls.push(node)
      const method = callName(node.expression)
      if (rawProcessMethods.has(method)) {
        violation = true
      }
      if (!expectedMethod && relativePath !== observer && processHostMethods.has(method)) {
        violation = true
      }
    }
    if (
      ts.isPropertyAssignment(node) &&
      ((ts.isIdentifier(node.name) && node.name.text === 'program') ||
        (ts.isStringLiteral(node.name) && node.name.text === 'program') ||
        (ts.isComputedPropertyName(node.name) && literalString(node.name.expression) === 'program'))
    ) {
      programs.push(node.initializer)
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'program') {
      programs.push(node.name)
    }
    if (relativePath === initializer) {
      if (ts.isStringLiteral(node) && node.text === capture) {
        captureReferences.push(node)
      }
      if (
        ts.isStringLiteral(node) &&
        node.text === 'VsDevCmd.bat' &&
        !isDeveloperCommandMetadata(node)
      ) {
        violation = true
      }
      if (ts.isIdentifier(node) && node.text === 'devcmd') {
        if (!isDeveloperCommandUse(node)) {
          violation = true
        }
        if (ts.isVariableDeclaration(node.parent) && node.parent.name === node) {
          developerCommandDeclarations += 1
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (
    expectedMethod &&
    !calls.some(
      (call) => ts.isIdentifier(call.expression) && importedMethods.has(call.expression.text)
    )
  ) {
    violation = true
  }
  if (relativePath === initializer && developerCommandDeclarations !== 1) {
    violation = true
  }
  if (captureReferences.some((node) => !isProcessHostCapture(node, importedMethods))) {
    violation = true
  }
  // Reuse package-path folding for process-host's named program option.
  return (
    violation ||
    hasNodeModulesBinSpawn(contents) ||
    programs.some((program) =>
      hasNodeModulesBinSpawn(`${contents}\nspawnSync(${program.getText(source)})`)
    )
  )
}
