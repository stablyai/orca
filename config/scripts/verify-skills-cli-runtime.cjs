const { existsSync, readFileSync, realpathSync } = require('node:fs')
const { builtinModules, createRequire, isBuiltin } = require('node:module')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')
const { spawnSync } = require('node:child_process')
const ts = require('typescript-api')

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]))
const CLI_COMMAND_TIMEOUT_MS = 30_000

function artifactPath(outDir, file) {
  return relative(outDir, file).split(sep).join('/')
}

function runtimeImportSpecifiers(source, file) {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS
  )
  const specifiers = []

  function visit(node) {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const [argument] = node.arguments
      const expression = node.expression
      const isRequire = ts.isIdentifier(expression) && expression.text === 'require'
      const isRequireResolve =
        ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === 'require' &&
        expression.name.text === 'resolve'
      const isDynamicImport = expression.kind === ts.SyntaxKind.ImportKeyword

      if ((isRequire || isRequireResolve || isDynamicImport) && ts.isStringLiteralLike(argument)) {
        specifiers.push(argument.text)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return specifiers
}

function isOutsideRoot(root, target) {
  const pathFromRoot = relative(root, target)
  return isAbsolute(pathFromRoot) || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`)
}

function isOptionalPackageImport(artifactRoot, importer, specifier) {
  if (specifier.startsWith('.') || isAbsolute(specifier)) {
    return false
  }
  const segments = specifier.split('/')
  const packageName = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]
  let directory = realpathSync(dirname(importer))

  while (!isOutsideRoot(artifactRoot, directory)) {
    const packageJson = join(directory, 'package.json')
    if (existsSync(packageJson)) {
      try {
        const manifest = JSON.parse(readFileSync(packageJson, 'utf8'))
        return (
          Object.hasOwn(manifest.optionalDependencies ?? {}, packageName) ||
          manifest.peerDependenciesMeta?.[packageName]?.optional === true
        )
      } catch {
        return false
      }
    }
    if (directory === artifactRoot) {
      break
    }
    directory = dirname(directory)
  }
  return false
}

function resolveRuntimeImport(outDir, artifactRoot, importer, specifier) {
  if (BUILTINS.has(specifier) || isBuiltin(specifier)) {
    return null
  }
  let resolved
  try {
    resolved = createRequire(importer).resolve(specifier)
  } catch (error) {
    if (isOptionalPackageImport(artifactRoot, importer, specifier)) {
      return null
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `[verify-skills-cli-runtime] missing runtime import "${specifier}" from ` +
        `${artifactPath(outDir, importer)}: ${detail}`
    )
  }
  if (isOutsideRoot(artifactRoot, resolved)) {
    throw new Error(
      `[verify-skills-cli-runtime] import "${specifier}" from ` +
        `${artifactPath(outDir, importer)} resolved outside ${artifactRoot}: ${resolved}`
    )
  }
  return resolved
}

function collectRuntimeClosure(outDir, artifactRoot = dirname(outDir)) {
  outDir = realpathSync(outDir)
  artifactRoot = realpathSync(artifactRoot)
  if (isOutsideRoot(artifactRoot, outDir)) {
    throw new Error(`[verify-skills-cli-runtime] ${outDir} is outside ${artifactRoot}`)
  }
  const entry = resolve(outDir, 'cli', 'index.js')
  if (!existsSync(entry)) {
    throw new Error(`[verify-skills-cli-runtime] missing entry ${entry}`)
  }
  const pending = [entry]
  const visited = new Set()

  while (pending.length > 0) {
    const file = pending.pop()
    if (!file || visited.has(file)) {
      continue
    }
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    for (const specifier of runtimeImportSpecifiers(source, file)) {
      const resolved = resolveRuntimeImport(outDir, artifactRoot, file, specifier)
      if (resolved && !isOutsideRoot(artifactRoot, resolved) && /\.(?:c|m)?js$/.test(resolved)) {
        pending.push(resolved)
      }
    }
  }

  return [...visited].sort()
}

function runCli(outDir, args, timeoutMs = CLI_COMMAND_TIMEOUT_MS) {
  const entry = resolve(outDir, 'cli', 'index.js')
  const env = { ...process.env, NODE_PATH: '' }
  delete env.ORCA_CLI_CWD
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: dirname(outDir),
    encoding: 'utf8',
    env,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs
  })
  if (result.error || result.signal || result.status !== 0) {
    const detail = [
      result.error?.message,
      result.signal ? `terminated by ${result.signal}` : null,
      result.stdout,
      result.stderr
    ]
      .filter(Boolean)
      .join('\n')
    throw new Error(
      `[verify-skills-cli-runtime] ${args.join(' ')} exited ${String(result.status)}\n${detail}`
    )
  }
  return result.stdout
}

function parseJson(label, output) {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error(`[verify-skills-cli-runtime] ${label} emitted invalid JSON:\n${output}`)
  }
}

function verifySkillsCliRuntime(outDir, artifactRoot = dirname(outDir), options = {}) {
  const absoluteOutDir = resolve(outDir)
  const closure = collectRuntimeClosure(absoluteOutDir, resolve(artifactRoot))
  if (options.executeCommands === false) {
    return { closureFiles: closure.length, commands: 0 }
  }
  const list = parseJson('skills list', runCli(absoluteOutDir, ['skills', 'list', '--json']))
  const topicNames = new Set(list.topics?.map((topic) => topic.name))
  for (const topic of ['orca-cli', 'computer-use']) {
    if (!topicNames.has(topic)) {
      throw new Error(`[verify-skills-cli-runtime] skills list omitted ${topic}`)
    }
    const guide = runCli(absoluteOutDir, ['skills', 'get', topic])
    if (!guide.includes(`name: ${topic}`)) {
      throw new Error(`[verify-skills-cli-runtime] skills get ${topic} returned the wrong guide`)
    }
  }

  const install = parseJson(
    'skills install --dry-run',
    runCli(absoluteOutDir, [
      'skills',
      'install',
      '--skill',
      'orca-cli',
      '--agent',
      'codex',
      '--dry-run',
      '--json'
    ])
  )
  const update = parseJson(
    'skills update --dry-run',
    runCli(absoluteOutDir, ['skills', 'update', '--skill', 'orca-cli', '--dry-run', '--json'])
  )
  if (install.executed !== false || update.executed !== false) {
    throw new Error('[verify-skills-cli-runtime] a dry-run reported execution')
  }

  return { closureFiles: closure.length, commands: 5 }
}

if (require.main === module) {
  try {
    const result = verifySkillsCliRuntime(process.argv[2] ?? 'out')
    console.log(
      `[verify-skills-cli-runtime] ${result.closureFiles} closure files and ` +
        `${result.commands} commands passed`
    )
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

module.exports = { collectRuntimeClosure, runCli, verifySkillsCliRuntime }
