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

export async function startVirtualDisplay() {
  const xvfb = process.platform === 'linux' ? findOnPath('Xvfb') : null
  if (!xvfb) {
    return null
  }
  let number = 140 + Math.floor(Math.random() * 400)
  while (fs.existsSync(`/tmp/.X11-unix/X${number}`) || fs.existsSync(`/tmp/.X${number}-lock`)) {
    number += 1
  }
  const child = spawn(xvfb, [`:${number}`, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], {
    stdio: 'ignore'
  })
  const deadline = Date.now() + 10_000
  while (!fs.existsSync(`/tmp/.X11-unix/X${number}`)) {
    if (Date.now() > deadline || child.exitCode !== null) {
      child.kill('SIGKILL')
      return null
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { display: `:${number}`, stop: () => child.kill('SIGTERM') }
}
