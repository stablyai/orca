export function createCheckLogFixture() {
  const expectedDiagnostic = 'Error: expected 200, received 500'
  const expectedStackFrame = 'request.test.ts:18:8'
  const benignMarker = 'stderr | request test: retrying connection'
  const genericExitMarker = '##[error]Process completed with exit code 1.'
  return {
    expectedDiagnostic,
    expectedStackFrame,
    benignMarker,
    genericExitMarker,
    rawLog: [
      `\x1b[90m${benignMarker}\x1b[0m`,
      '\x1b[41m FAIL \x1b[0m request test',
      `\x1b[31mError\x1b[0m: expected 200, received 500`,
      `  at handleRequest (${expectedStackFrame})`,
      genericExitMarker,
      ''
    ].join('\n')
  }
}
