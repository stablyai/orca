import type {
  ClaudeUsageParseResumeState,
  ClaudeUsagePersistedFile,
  ClaudeUsagePersistedState,
  ClaudeUsageTokenMaxima
} from './types'

const TOKEN_CODEC_VERSION = 1
const DECODE_ROWS_PER_YIELD = 1024

type PersistedTokenColumn = number | null | (number | null)[]
type TokenColumnIndex = 0 | 1 | 2 | 3 | 4 | 5
type PackedResumeState = Omit<ClaudeUsageParseResumeState, 'ownedTokenMaxima'> & {
  tokenCodecVersion: 1
  ownedTokenColumns: PersistedTokenColumn[]
}
type PackedFile = Omit<ClaudeUsagePersistedFile, 'parseResumeState'> & {
  parseResumeState?: ClaudeUsageParseResumeState | PackedResumeState | null
}

function encodeColumn(
  rows: ClaudeUsageTokenMaxima[],
  index: TokenColumnIndex
): PersistedTokenColumn {
  let column: PersistedTokenColumn = rows[0]?.[index] ?? (index === 5 ? null : 0)
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const value = rows[rowIndex][index]
    if (Array.isArray(column)) {
      column.push(value)
    } else if (value !== column) {
      const priorValue = column
      const values = Array.from({ length: rowIndex }, () => priorValue)
      values.push(value)
      column = values
    }
  }
  return column
}

function encodeFile(file: ClaudeUsagePersistedFile): PackedFile {
  const state = file.parseResumeState
  if (
    !state ||
    typeof state.projectionIntegrity !== 'string' ||
    !Array.isArray(state.ownedTokenMaxima)
  ) {
    return file
  }
  const { ownedTokenMaxima, ...checkpoint } = state
  return {
    ...file,
    parseResumeState: {
      ...checkpoint,
      tokenCodecVersion: TOKEN_CODEC_VERSION,
      ownedTokenColumns: ([0, 1, 2, 3, 4, 5] as const).map((index) =>
        encodeColumn(ownedTokenMaxima, index)
      )
    }
  }
}

export function encodeClaudeUsagePersistedFiles(
  files: readonly ClaudeUsagePersistedFile[]
): readonly unknown[] {
  // Serialize one file at a time so dense columns do not accumulate across the corpus.
  return files.map((file) => ({ toJSON: () => encodeFile(file) }))
}

export function encodeClaudeUsagePersistedState(state: ClaudeUsagePersistedState): unknown {
  return { ...state, processedFiles: encodeClaudeUsagePersistedFiles(state.processedFiles) }
}

function columnValue(column: unknown, rowIndex: number): unknown {
  return Array.isArray(column) ? column[rowIndex] : column
}

function readToken(column: unknown, rowIndex: number): number {
  const value = columnValue(column, rowIndex)
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('Saved Claude usage token column contains an invalid maximum.')
  }
  return value
}

function readProjection(column: unknown, rowIndex: number, projectionCount: number): number | null {
  const value = columnValue(column, rowIndex)
  if (value === null) {
    return null
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value >= projectionCount
  ) {
    throw new Error('Saved Claude usage token column contains an invalid route index.')
  }
  return value
}

export function* decodeClaudeUsagePersistedFile(
  file: ClaudeUsagePersistedFile
): Generator<void, ClaudeUsagePersistedFile> {
  const resume = file.parseResumeState
  if (resume === null || resume === undefined) {
    return file
  }
  const state: unknown = resume
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Saved Claude usage resume checkpoint is invalid.')
  }
  if (!('tokenCodecVersion' in state) && !('ownedTokenColumns' in state)) {
    return file
  }
  if (
    !('tokenCodecVersion' in state) ||
    state.tokenCodecVersion !== TOKEN_CODEC_VERSION ||
    !('ownedTokenColumns' in state) ||
    'ownedTokenMaxima' in state ||
    !('projectionIntegrity' in state) ||
    typeof state.projectionIntegrity !== 'string' ||
    !Array.isArray(file.ownedDedupeKeys) ||
    !('projections' in state) ||
    !Array.isArray(state.projections)
  ) {
    throw new Error('Saved Claude usage token codec is invalid or unsupported.')
  }
  const columns = state.ownedTokenColumns
  if (!Array.isArray(columns) || columns.length !== 6) {
    throw new Error('Saved Claude usage token checkpoint requires six columns.')
  }
  const rowCount = file.ownedDedupeKeys.length
  for (const [index, column] of columns.entries()) {
    if (Array.isArray(column)) {
      if (column.length !== rowCount) {
        throw new Error('Saved Claude usage token column does not match its ownership keys.')
      }
    } else if (index === 5) {
      readProjection(column, 0, state.projections.length)
    } else {
      readToken(column, 0)
    }
  }
  const ownedTokenMaxima: ClaudeUsageTokenMaxima[] = []
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex++) {
    ownedTokenMaxima.push([
      readToken(columns[0], rowIndex),
      readToken(columns[1], rowIndex),
      readToken(columns[2], rowIndex),
      readToken(columns[3], rowIndex),
      readToken(columns[4], rowIndex),
      readProjection(columns[5], rowIndex, state.projections.length)
    ])
    if ((rowIndex + 1) % DECODE_ROWS_PER_YIELD === 0) {
      yield
    }
  }
  const checkpoint: ClaudeUsageParseResumeState & {
    tokenCodecVersion?: unknown
    ownedTokenColumns?: unknown
  } = { ...resume, ownedTokenMaxima }
  delete checkpoint.tokenCodecVersion
  delete checkpoint.ownedTokenColumns
  return { ...file, parseResumeState: checkpoint }
}
