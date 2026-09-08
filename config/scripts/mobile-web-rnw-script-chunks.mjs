import ts from 'typescript-api'
import { MOBILE_WEB_MAX_ASSET_BYTES } from '../../src/shared/mobile-web/manifest-contract.ts'

export const MOBILE_WEB_RNW_SCRIPT_CHUNK_BYTES = 2 * 1024 * 1024

export function splitMobileWebRnwScript(source, limit = MOBILE_WEB_RNW_SCRIPT_CHUNK_BYTES) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MOBILE_WEB_MAX_ASSET_BYTES) {
    throw new Error('Invalid script chunk limit')
  }
  if (Buffer.byteLength(source) <= limit) {
    return [source]
  }
  const program = ts.createSourceFile(
    'bundle.js',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  )
  if (program.parseDiagnostics.length) {
    throw new Error('Cannot split invalid RNW JavaScript')
  }
  const firstModule = program.statements.findIndex((statement) => callName(statement) === '__d')
  if (firstModule === -1) {
    throw new Error('RNW bundle has no Metro module boundaries')
  }
  let started = false
  for (const statement of program.statements.slice(firstModule)) {
    const name = callName(statement)
    if (name === '__r') {
      started = true
    } else if (name !== '__d' || started) {
      throw new Error('Unexpected Metro module/startup ordering')
    }
  }
  // Splits contain only module registrations and startup calls, preserving prelude hoisting.
  const boundaries = program.statements.slice(firstModule).map((statement) => statement.pos)
  boundaries.push(source.length)
  const directives = program.statements
    .slice(0, firstModule)
    .filter(
      (statement, index) =>
        program.statements.slice(0, index + 1).every(isDirective) && isDirective(statement)
    )
    .map((statement) => source.slice(statement.pos, statement.end))
    .join('')
  const chunks = []
  let chunk = source.slice(0, boundaries[0])
  let chunkBytes = Buffer.byteLength(chunk)
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const unit = source.slice(boundaries[index], boundaries[index + 1])
    const unitBytes = Buffer.byteLength(unit)
    if (chunkBytes + unitBytes > limit) {
      if (chunkBytes > MOBILE_WEB_MAX_ASSET_BYTES) {
        throw new Error('RNW prelude exceeds native asset limit')
      }
      if (chunk) {
        chunks.push(chunk)
      }
      chunk = directives
      chunkBytes = Buffer.byteLength(directives)
    }
    chunk += unit
    chunkBytes += unitBytes
    if (chunkBytes > MOBILE_WEB_MAX_ASSET_BYTES) {
      throw new Error('RNW module exceeds native asset limit')
    }
  }
  if (chunk) {
    chunks.push(chunk)
  }
  return chunks
}

function callName(statement) {
  return ts.isExpressionStatement(statement) &&
    ts.isCallExpression(statement.expression) &&
    ts.isIdentifier(statement.expression.expression)
    ? statement.expression.expression.text
    : undefined
}

function isDirective(statement) {
  return ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)
}
