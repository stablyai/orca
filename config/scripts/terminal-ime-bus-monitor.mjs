import { spawn, spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const logLimitBytes = 2 * 1024 * 1024

export async function startTerminalImeBusMonitor(evidenceDir) {
  const evidence = { startedAt: Date.now(), pid: null, bytes: 0, truncated: false, error: null }
  const chunks = []
  const logPath = path.join(evidenceDir, 'terminal-wayland-ibus-monitor.log')
  const address = spawnSync('ibus', ['address'], { encoding: 'utf8', timeout: 10_000 })
  if (address.status !== 0 || !address.stdout.trim()) {
    evidence.error = `IBus address unavailable: ${address.error ?? address.stderr}`
    return { evidence, logPath, save: () => writeFileSync(logPath, JSON.stringify(evidence)) }
  }

  const child = spawn(
    'dbus-monitor',
    [
      '--address',
      address.stdout.trim(),
      "interface='org.freedesktop.IBus.InputContext'",
      "interface='org.freedesktop.IBus.Engine'"
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  evidence.pid = child.pid ?? null
  const record = (chunk) => {
    const remaining = Math.max(0, logLimitBytes - evidence.bytes)
    if (remaining > 0) {
      chunks.push(chunk.subarray(0, remaining))
    }
    evidence.truncated ||= chunk.length > remaining
    evidence.bytes += Math.min(remaining, chunk.length)
  }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  child.on('error', (error) => {
    evidence.error = error.message
  })
  const closed = new Promise((resolve) => child.once('close', resolve))
  await new Promise((resolve) => setTimeout(resolve, 250))
  evidence.startupExitCode = child.exitCode
  if (child.exitCode !== null) {
    evidence.error ??= 'IBus monitor exited before tests started'
  }
  return {
    process: child,
    evidence,
    logPath,
    async save() {
      // Drain final monitor output after the runner stops its owned process group.
      let drainTimer
      try {
        evidence.drained = await Promise.race([
          closed.then(() => true),
          new Promise((resolve) => {
            drainTimer = setTimeout(() => resolve(false), 2_000)
          })
        ])
      } finally {
        clearTimeout(drainTimer)
      }
      writeFileSync(logPath, Buffer.concat(chunks))
      evidence.exitCode = child.exitCode
      evidence.signalCode = child.signalCode
      evidence.finishedAt = Date.now()
    }
  }
}
