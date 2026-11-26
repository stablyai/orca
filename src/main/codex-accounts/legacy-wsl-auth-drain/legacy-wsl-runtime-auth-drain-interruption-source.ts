/** Interruption fixtures must never signal the runner's inherited process group. */
export const DRAIN_APPLY_INTERRUPTION_JS = String.raw`
function interruptDrainApply(ancestorDepth) {
  const expectedText = process.env.ORCA_DRAIN_APPLY_PID || ''
  if (!/^[1-9][0-9]*$/.test(expectedText)) throw new Error('Missing owned apply PID')
  const expectedPid = Number(expectedText)
  if (!Number.isSafeInteger(expectedPid) || expectedPid <= 1 || expectedPid === process.pid) {
    throw new Error('Invalid owned apply PID')
  }
  let ancestor = process.pid
  for (let depth = 0; depth < ancestorDepth; depth++) {
    const result = require('node:child_process').spawnSync(
      '/bin/ps', ['-o', 'ppid=', '-p', String(ancestor)], { encoding: 'utf8' }
    )
    const text = typeof result.stdout === 'string' ? result.stdout.trim() : ''
    if (result.status !== 0 || result.signal || result.error || !/^[1-9][0-9]*$/.test(text)) {
      throw new Error('Unverified apply ancestry')
    }
    ancestor = Number(text)
    if (!Number.isSafeInteger(ancestor) || ancestor <= 1) throw new Error('Invalid apply ancestor')
  }
  if (ancestor !== expectedPid) throw new Error('Apply ancestor is not owned')
  process.kill(ancestor, 'SIGKILL')
}
`
