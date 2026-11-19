// A private X display for Linux runs: hidden windows never paint, so clicks and screenshots would stall.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function findOnPath(binary) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, binary)
    if (dir && fs.existsSync(candidate)) {
      return candidate
    }
  }
  return null
}

/** tracker (recordHelperLaunch) marks Xvfb before it spawns, so a gate killed during its startup still has it on file. */
export async function startVirtualDisplay(tracker = null) {
  const xvfb = process.platform === 'linux' ? findOnPath('Xvfb') : null
  if (!xvfb) {
    tracker?.done()
    return null
  }
  // -displayfd: Xvfb picks a free display itself and reports it once ready, so two runs can't claim the same one.
  const child = spawn(
    xvfb,
    ['-displayfd', '3', '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
      // Xvfb rejects unknown arguments, so its marker rides in the environment.
      env: { ...process.env, ...tracker?.env }
    }
  )
  const recorded = tracker?.record(child.pid) ?? (() => {})
  const forget = () => {
    recorded()
    tracker?.done()
  }
  const number = await new Promise((resolve) => {
    let text = ''
    const timer = setTimeout(() => resolve(null), 10_000)
    child.stdio[3].on('data', (chunk) => {
      text += String(chunk)
      if (text.includes('\n')) {
        clearTimeout(timer)
        resolve(text.trim())
      }
    })
    for (const event of ['exit', 'error']) {
      child.once(event, () => {
        clearTimeout(timer)
        resolve(null)
      })
    }
  })
  if (!number || !/^\d+$/.test(number)) {
    child.kill('SIGKILL')
    forget()
    return null
  }
  return {
    display: `:${number}`,
    stop() {
      child.kill('SIGTERM')
      forget()
    }
  }
}
