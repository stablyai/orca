import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, relative, sep } from 'node:path'
// Why: the repo's main `typescript` dep (^7.0.2) ships only the native tsc CLI shim (no
// ts.LanguageService/ts.sys/etc.) — `typescript-api` aliases the last classic JS package
// (6.0.3) that still exposes the Language Service API this file needs.
import ts from 'typescript-api'
import type {
  EditorLanguageDefinitionResult,
  EditorLanguageRequest
} from '../../shared/editor-language-types'

type TypeScriptProject = {
  configPath: string
  // configPath plus every transitively `extends`-ed config, so inherited changes are detected too.
  configPaths: string[]
  configVersion: string
  options: ts.CompilerOptions
  fileNames: Set<string>
  overrides: Map<string, { content: string; version: number }>
  service: ts.LanguageService
}

const projectsByConfigPath = new Map<string, TypeScriptProject>()
const require = createRequire(import.meta.url)
const typeScriptLibDirectory = dirname(require.resolve('typescript-api/lib/lib.es2022.d.ts'))

function resolveTypeScriptSystemPath(filePath: string): string {
  const fileName = basename(filePath)
  return /^lib\..*\.d\.ts$/i.test(fileName) && !ts.sys.fileExists(filePath)
    ? `${typeScriptLibDirectory}/${fileName}`
    : filePath
}

function findConfigPath(filePath: string, rootPath: string): string | null {
  const configPath = ts.findConfigFile(dirname(filePath), ts.sys.fileExists, 'tsconfig.json')
  if (!configPath) {
    return null
  }
  const relativeConfigPath = relative(rootPath, configPath)
  const isOutsideRoot =
    relativeConfigPath === '..' ||
    relativeConfigPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeConfigPath)
  return isOutsideRoot ? null : configPath
}

function readProjectConfig(configPath: string): {
  options: ts.CompilerOptions
  fileNames: Set<string>
  configPaths: string[]
} {
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  // Populated with every resolved `extends` config, keyed by absolute path.
  const extendedConfigCache = new Map<string, ts.ExtendedConfigCacheEntry>()
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
    undefined,
    undefined,
    extendedConfigCache
  )
  return {
    options: parsed.options,
    fileNames: new Set(parsed.fileNames),
    configPaths: [configPath, ...extendedConfigCache.keys()]
  }
}

function hashFileContent(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

function getConfigVersion(configPaths: string[]): string {
  return configPaths
    .map((configPath) => {
      const content = ts.sys.readFile(configPath)
      return content === undefined ? 'missing' : hashFileContent(content)
    })
    .join(':')
}

// Refreshes the cached project's options/fileNames in place when tsconfig.json (or an
// inherited config) changes on disk, rather than serving a stale parse forever.
function refreshProjectConfigIfChanged(project: TypeScriptProject): void {
  const configVersion = getConfigVersion(project.configPaths)
  if (configVersion === project.configVersion) {
    return
  }
  try {
    const config = readProjectConfig(project.configPath)
    project.options = config.options
    project.fileNames = config.fileNames
    project.configPaths = config.configPaths
    project.configVersion = getConfigVersion(config.configPaths)
  } catch {
    // A transiently-invalid tsconfig (e.g. mid-edit) keeps serving the last-good options.
  }
}

function getOrCreateProject(configPath: string): TypeScriptProject {
  const existing = projectsByConfigPath.get(configPath)
  if (existing) {
    refreshProjectConfigIfChanged(existing)
    return existing
  }

  const config = readProjectConfig(configPath)
  const project: TypeScriptProject = {
    configPath,
    configPaths: config.configPaths,
    configVersion: getConfigVersion(config.configPaths),
    options: config.options,
    fileNames: config.fileNames,
    overrides: new Map(),
    service: undefined as never
  }

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => project.options,
    getCurrentDirectory: () => dirname(project.configPath),
    getDefaultLibFileName: (options) =>
      resolveTypeScriptSystemPath(ts.getDefaultLibFilePath(options)),
    getNewLine: () => ts.sys.newLine,
    getScriptFileNames: () =>
      Array.from(new Set([...project.fileNames, ...project.overrides.keys()])),
    getScriptSnapshot: (filePath) => {
      const override = project.overrides.get(filePath)
      const content = override?.content ?? ts.sys.readFile(resolveTypeScriptSystemPath(filePath))
      return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content)
    },
    getScriptVersion: (filePath) => {
      const override = project.overrides.get(filePath)
      if (override) {
        return `override:${override.version}`
      }
      // stat (not read+hash) so an on-disk edit elsewhere is detected without re-reading the file.
      try {
        const stats = statSync(resolveTypeScriptSystemPath(filePath))
        return `${stats.mtimeMs}:${stats.size}`
      } catch {
        return 'missing'
      }
    },
    fileExists: (filePath) => ts.sys.fileExists(resolveTypeScriptSystemPath(filePath)),
    readFile: (filePath, encoding) =>
      ts.sys.readFile(resolveTypeScriptSystemPath(filePath), encoding),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames
  }

  project.service = ts.createLanguageService(host, ts.createDocumentRegistry())
  projectsByConfigPath.set(configPath, project)
  return project
}

function updateOpenFile(project: TypeScriptProject, filePath: string, content: string): void {
  const existing = project.overrides.get(filePath)
  if (existing?.content === content) {
    return
  }
  project.overrides.set(filePath, {
    content,
    version: (existing?.version ?? 0) + 1
  })
}

function getPositionOffset(sourceFile: ts.SourceFile, position: EditorLanguageRequest['position']) {
  return ts.getPositionOfLineAndCharacter(sourceFile, position.lineNumber - 1, position.column - 1)
}

function textSpanToRange(sourceFile: ts.SourceFile, textSpan: ts.TextSpan) {
  const start = sourceFile.getLineAndCharacterOfPosition(textSpan.start)
  const end = sourceFile.getLineAndCharacterOfPosition(textSpan.start + textSpan.length)
  return {
    startLineNumber: start.line + 1,
    startColumn: start.character + 1,
    endLineNumber: end.line + 1,
    endColumn: end.character + 1
  }
}

function getProjectForRequest(request: EditorLanguageRequest): TypeScriptProject | null {
  const configPath = findConfigPath(request.filePath, request.rootPath)
  if (!configPath) {
    return null
  }
  const project = getOrCreateProject(configPath)
  updateOpenFile(project, request.filePath, request.content)
  return project
}

export function getTypeScriptDefinition(
  request: EditorLanguageRequest
): EditorLanguageDefinitionResult | null {
  const project = getProjectForRequest(request)
  const sourceFile = project?.service.getProgram()?.getSourceFile(request.filePath)
  if (!project || !sourceFile) {
    return null
  }
  const offset = getPositionOffset(sourceFile, request.position)
  const definitionAndSpan = project.service.getDefinitionAndBoundSpan(request.filePath, offset)
  const definitions =
    definitionAndSpan?.definitions ??
    project.service.getDefinitionAtPosition(request.filePath, offset) ??
    []
  const definition =
    definitions.find(
      (candidate) =>
        candidate.fileName !== request.filePath ||
        candidate.textSpan.start !== definitionAndSpan?.textSpan.start
    ) ?? definitions[0]
  const definitionSource = definition
    ? project.service.getProgram()?.getSourceFile(definition.fileName)
    : null
  if (!definition || !definitionSource) {
    const implementations = project.service.getImplementationAtPosition(request.filePath, offset)
    const implementation = implementations?.[0]
    const implementationSource = implementation
      ? project.service.getProgram()?.getSourceFile(implementation.fileName)
      : null
    if (!implementation || !implementationSource) {
      return null
    }
    return {
      filePath: implementation.fileName,
      range: textSpanToRange(implementationSource, implementation.textSpan)
    }
  }
  return {
    filePath: definition.fileName,
    range: textSpanToRange(definitionSource, definition.textSpan)
  }
}
