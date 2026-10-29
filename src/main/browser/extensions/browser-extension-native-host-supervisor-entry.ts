import { dirname } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import { assignHostProcessToStrictKillOnCloseJob } from '../../windows/windows-pty-job'

// The supervisor joins its job before the native host can create descendants.
process.once('disconnect', () => process.exit(0))

function failStartup(error: unknown): void {
  console.error('[browser-extensions] Native host supervisor:', error)
  if (process.connected && process.send) {
    process.send({ type: 'error' }, () => process.exit(1))
  } else {
    process.exit(1)
  }
}

const [runAsNode, program, ...args] = process.argv.slice(2)
if (
  process.platform !== 'win32' ||
  !process.connected ||
  !program ||
  !assignHostProcessToStrictKillOnCloseJob()
) {
  failStartup('Strict process ownership is unavailable.')
} else {
  const env = { ...process.env }
  if (runAsNode) {
    env.ELECTRON_RUN_AS_NODE = runAsNode
  } else {
    delete env.ELECTRON_RUN_AS_NODE
  }
  try {
    const host = spawnProcess({ program, args, cwd: dirname(program), env, stdio: 'inherit' })
    let announced = false
    let exitCode: number | undefined
    host.once('error', failStartup)
    host.once('spawn', () => {
      if (!process.connected || !process.send) {
        process.exit(1)
      }
      process.send({ type: 'ready' }, (error) => {
        if (error) {
          process.exit(1)
        }
        announced = true
        if (exitCode !== undefined) {
          process.exit(exitCode)
        }
      })
    })
    host.once('exit', (code) => {
      exitCode = code ?? 1
      if (announced) {
        process.exit(exitCode)
      }
    })
  } catch (error) {
    failStartup(error)
  }
}
