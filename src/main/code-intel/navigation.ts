import { relative } from 'path'
import type ts from 'typescript'
import {
  CODE_INTEL_MAX_LOCATIONS,
  CODE_INTEL_MAX_PREVIEW_LEN,
  type CodeIntelLocation,
  type CodeIntelRange,
  type CodeIntelRequest,
  type CodeIntelResult
} from '../../shared/code-intel-contract'
import type { LanguageServicePool } from './language-service-pool'

const SUPPORTED_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/

type RawSpan = { fileName: string; textSpan: ts.TextSpan }

export function getDefinition(
  pool: LanguageServicePool,
  request: CodeIntelRequest,
  token?: ts.CancellationToken
): CodeIntelResult {
  return run(
    pool,
    request,
    (service, offset) => {
      const defs = service.getDefinitionAtPosition(request.filePath, offset)
      return (defs ?? []).map((d) => ({ fileName: d.fileName, textSpan: d.textSpan }))
    },
    token
  )
}

export function findReferences(
  pool: LanguageServicePool,
  request: CodeIntelRequest,
  token?: ts.CancellationToken
): CodeIntelResult {
  return run(
    pool,
    request,
    (service, offset) => {
      const refs = service.getReferencesAtPosition(request.filePath, offset)
      return (refs ?? []).map((r) => ({ fileName: r.fileName, textSpan: r.textSpan }))
    },
    token
  )
}

function run(
  pool: LanguageServicePool,
  request: CodeIntelRequest,
  query: (service: ts.LanguageService, offset: number) => RawSpan[],
  token?: ts.CancellationToken
): CodeIntelResult {
  if (!SUPPORTED_EXT.test(request.filePath)) {
    return { status: 'unsupported', reason: 'not-ts' }
  }
  if (request.bufferText !== undefined) {
    pool.setOverlay(request.filePath, request.bufferText, request.bufferVersion)
  } else {
    // Why: drop any overlay from an earlier dirty query of this file, else its
    // stale unsaved text would shadow the on-disk content we should now read.
    pool.clearOverlay()
  }
  const entry = pool.acquire(request.filePath)
  if (!entry) {
    return { status: 'unsupported', reason: 'no-tsconfig' }
  }
  try {
    const program = entry.service.getProgram()
    if (!program) {
      return { status: 'error', code: 'no-program', message: 'language service has no program' }
    }
    const target = program.getSourceFile(request.filePath)
    if (!target) {
      return { status: 'unsupported', reason: 'no-tsconfig' }
    }
    token?.throwIfCancellationRequested()
    const offset = target.getPositionOfLineAndCharacter(
      request.position.line,
      request.position.character
    )
    const spans = query(entry.service, offset)
    const locations: CodeIntelLocation[] = []
    let truncated = false
    for (const span of spans) {
      token?.throwIfCancellationRequested()
      if (locations.length >= CODE_INTEL_MAX_LOCATIONS) {
        truncated = true
        break
      }
      const sourceFile = program.getSourceFile(span.fileName)
      if (!sourceFile) {
        continue
      }
      locations.push(toLocation(entry.projectRoot, sourceFile, span.textSpan))
    }
    return { status: 'ok', bufferVersion: request.bufferVersion, locations, truncated }
  } catch (error) {
    if (token?.isCancellationRequested()) {
      return { status: 'error', code: 'cancelled', message: 'request cancelled' }
    }
    return {
      status: 'error',
      code: 'navigation-failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function toLocation(
  projectRoot: string,
  sourceFile: ts.SourceFile,
  span: ts.TextSpan
): CodeIntelLocation {
  const start = sourceFile.getLineAndCharacterOfPosition(span.start)
  const end = sourceFile.getLineAndCharacterOfPosition(span.start + span.length)
  const range: CodeIntelRange = {
    start: { line: start.line, character: start.character },
    end: { line: end.line, character: end.character }
  }
  const lineStart = sourceFile.getPositionOfLineAndCharacter(start.line, 0)
  const lineText = sourceFile.text.slice(lineStart, span.start + span.length + 80)
  const preview = lineText.split('\n')[0]?.trim().slice(0, CODE_INTEL_MAX_PREVIEW_LEN)
  return {
    absolutePath: sourceFile.fileName,
    relativePath: relative(projectRoot, sourceFile.fileName).replace(/\\/g, '/'),
    range,
    preview
  }
}
