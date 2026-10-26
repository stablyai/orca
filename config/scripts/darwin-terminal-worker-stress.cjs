const { setTimeout: delay } = require('node:timers/promises')
const fs = require('node:fs/promises')
const pty = require(process.argv[3])
const canary = require(process.argv[2])

const target = 30_000_000
const began = Date.now()
const terminal = pty.spawn(
  '/bin/sh',
  ['-c', 'while IFS= read -r line; do printf "ECHO:%s\\n" "$line"; done'],
  { cwd: process.argv[4], env: process.env }
)
let output = ''
terminal.onData((chunk) => {
  output = (output + chunk).slice(-4096)
})
const deadline = setTimeout(() => {
  console.error('Stress run exceeded one hour')
  terminal.kill()
  process.kill(process.pid, 'SIGKILL')
}, 60 * 60_000)

async function echo(marker, timeoutMs = 10_000) {
  terminal.write(`${marker}\r`)
  const echoDeadline = Date.now() + timeoutMs
  while (Date.now() < echoDeadline) {
    if (output.includes(`ECHO:${marker}`)) {
      return
    }
    await delay(10)
  }
  throw new Error(`No PTY echo for ${marker}`)
}

async function main() {
  await echo('ORCA_BEFORE')
  canary.startStress()
  let previous = 0
  let lastProgress = Date.now()
  let lastPrint = 0
  while (canary.stressProgress() < target) {
    await delay(100)
    const completed = canary.stressProgress()
    if (completed !== previous) {
      previous = completed
      lastProgress = Date.now()
    }
    if (Date.now() - lastPrint > 10_000) {
      console.log(JSON.stringify({ elapsedMs: Date.now() - began, completed }))
      lastPrint = Date.now()
    }
    if (Date.now() - lastProgress > 3000) {
      const marker = `ORCA_AFTER_STALL_${completed}`
      await Promise.race([
        Promise.all([
          ...Array.from({ length: 4 }, () => fs.stat(process.execPath)),
          echo(marker, 40_000),
          (async () => {
            while (canary.stressProgress() <= completed) {
              await delay(100)
            }
          })()
        ]),
        delay(40_000, undefined, { ref: false }).then(() => {
          throw new Error(`Workers stranded after ${completed} jobs: I/O recovery timed out`)
        })
      ])
      lastProgress = Date.now()
    }
  }
  await fs.stat(process.execPath)
  await echo('ORCA_AFTER')
  console.log(JSON.stringify({ result: 'passed', arch: process.arch, completed: target }))
  clearTimeout(deadline)
  terminal.kill()
}
main().catch((error) => {
  console.error(error)
  terminal.kill()
  // Stalled libuv cleanup can block process.exit().
  process.kill(process.pid, 'SIGKILL')
})
