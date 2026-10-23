import { LIMIT, SEED } from './check-job-log-performance-cases.mjs'

// No controls or CR: these cases retain the original full-output contract.
export function* plainLogDifferentialCases() {
  const units = ['x', 'é', '界', '😀', '\ud83d', '\udc00', 'x\ud83d界\udc00']
  for (const unit of units) {
    for (let delta = -4; delta <= 4; delta++) {
      const text = unit.repeat(Math.floor(LIMIT / Buffer.byteLength(unit)) + delta)
      yield text
      yield `error: ${text}\n${'recent\n'.repeat(103)}`
    }
  }
  let seed = SEED
  const random = (max) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return (seed >>> 8) % max
  }
  const tokens = [
    'plain text',
    '##[error]',
    '::error::',
    'error:',
    'FAILED',
    'exit code',
    'ENOENT',
    'EACCES',
    'panic:',
    'AssertionError',
    'emoji 😀',
    '\ud83d',
    '\udc00',
    '界',
    'é'
  ]
  for (let iteration = 0; iteration < 5000; iteration++) {
    const rows = Array.from({ length: random(250) }, (_, index) => {
      const token = tokens[random(tokens.length)]
      const count = index === 0 && iteration % 20 === 0 ? LIMIT + random(4) : random(30)
      return `${token} ${index} ${units[random(units.length)].repeat(count)}`
    })
    yield rows.join('\n') + (iteration % 2 ? '\n' : '')
  }
}
