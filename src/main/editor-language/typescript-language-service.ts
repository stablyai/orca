import { createRequire } from 'node:module'
import { basename, dirname } from 'node:path'
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
  return configPath?.startsWith(rootPath) ? configPath : null
}

function readProjectConfig(configPath: string): {
  options: ts.CompilerOptions
  fileNames: Set<string>
} {
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error) {
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(configPath))
  return {
    options: parsed.options,
    fileNames: new Set(parsed.fileNames)
  }
}

function getOrCreateProject(configPath: string): TypeScriptProject {
  const existing = projectsByConfigPath.get(configPath)
  if (existing) {
    return existing
  }

  const config = readProjectConfig(configPath)
  const project: TypeScriptProject = {
    configPath,
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
    getScriptVersion: (filePath) => String(project.overrides.get(filePath)?.version ?? 0),
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
