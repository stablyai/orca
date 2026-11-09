/** Why a failed child failed, for CI logs where an empty stderr alone says nothing. */
export function describeProcessFailure(result) {
  const detail = [
    `code=${result.code ?? 'none'}`,
    `signal=${result.signal ?? 'none'}`,
    ...(result.timedOut ? ['timed out'] : []),
    ...(result.outputTruncated ? ['output truncated'] : [])
  ].join(' ')
  const stream = (name, text) => (text?.trim() ? `\n${name}:\n${text.trim().slice(-4000)}` : '')
  return `${detail}${stream('stdout', result.stdout)}${stream('stderr', result.stderr)}`
}
