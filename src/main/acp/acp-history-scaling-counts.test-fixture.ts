export function hasArrayKey(array: unknown[], key: PropertyKey): key is keyof unknown[] {
  return key in array
}

// Raw callsites avoid source-map formatting on every delegated operation.
export function operationStack(): string {
  const prepare = Error.prepareStackTrace
  try {
    Error.prepareStackTrace = (_error, sites) => {
      let result = 'operation attribution'
      for (const site of sites) {
        result += `\n    at ${site.getFunctionName() ?? site.getMethodName() ?? ''} (${site.getFileName() ?? ''})`
      }
      return result
    }
    const error = new Error('operation attribution')
    Error.captureStackTrace(error, operationStack)
    return error.stack ?? ''
  } finally {
    Error.prepareStackTrace = prepare
  }
}

export type ViewWork = {
  visitedRows: number
  itemReads: number
  submissionReturns: number
  submissionCopies: number
  canonicalEntries: number
  canonicalReads: number
}
type ExecutionPass = {
  phase: string
  construction: number
  predicates: number
  reciprocalReads: number
  executionItemIds: string[]
}
export function newCounts() {
  const views: ViewWork[] = []
  const execution: ExecutionPass[] = []
  const snapshots: { phase: string; rows: number }[] = []
  return {
    native: 0,
    suffix: 0,
    membership: 0,
    tree: 0,
    matching: 0,
    copies: 0,
    adopted: 0,
    views,
    execution,
    snapshots,
    frames: 0,
    inputUtf8Bytes: 0,
    frameVisits: 0,
    candidates: 0,
    translationObservations: 0,
    translatedItems: 0,
    candidateKeyUtf8Bytes: 0,
    retainedRows: 0,
    submissions: 0,
    canonicalKeyUtf8Bytes: 0,
    longestCanonicalKey: 0,
    resolverCanonicalReads: 0,
    otherCanonicalReads: 0,
    otherItemReads: 0,
    otherSubmissionReturns: 0,
    otherSubmissionCopies: 0,
    mutations: 0,
    commits: 0
  }
}
