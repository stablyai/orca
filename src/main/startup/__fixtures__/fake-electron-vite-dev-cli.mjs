import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

const __dirname = import.meta.dirname
const grandchildPath = path.join(__dirname, 'electron-vite-dev-grandchild.mjs')
const pidFile = process.env.ORCA_DEV_WRAPPER_TEST_PID_FILE
const envFile = process.env.ORCA_DEV_WRAPPER_TEST_ENV_FILE

const grandchild = spawn(process.execPath, [grandchildPath], {
  stdio: 'ignore'
})

let exiting = false

function killGrandchild(signal) {
  if (!grandchild.pid) {
    return
  }
  try {
    process.kill(grandchild.pid, signal)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code !== 'ESRCH') {
      throw error
    }
  }
}

function exitAfterGrandchild(signal, code) {
  if (exiting) {
    return
  }
  exiting = true
  killGrandchild(signal)
  const forceTimer = setTimeout(() => {
    killGrandchild('SIGKILL')
    process.exit(code)
  }, 1000)
  grandchild.once('exit', () => {
    clearTimeout(forceTimer)
    process.exit(code)
  })
}

process.once('SIGINT', () => {
  exitAfterGrandchild('SIGINT', 130)
})

process.once('SIGTERM', () => {
  exitAfterGrandchild('SIGTERM', 143)
})

if (!pidFile) {
  throw new Error('ORCA_DEV_WRAPPER_TEST_PID_FILE is required')
}

// Record both PIDs so assertion failures before SIGINT cannot leak the wrapper or its child.
writeFileSync(pidFile, `${process.pid}\n${grandchild.pid ?? ''}\n`, 'utf8')
if (envFile) {
  writeFileSync(
    envFile,
    JSON.stringify(
      {
        args: process.argv.slice(2),
        label: process.env.ORCA_DEV_INSTANCE_LABEL ?? null,
        branch: process.env.ORCA_DEV_BRANCH ?? null,
        worktreeName: process.env.ORCA_DEV_WORKTREE_NAME ?? null,
        repoRoot: process.env.ORCA_DEV_REPO_ROOT ?? null,
        badgeLabel: process.env.ORCA_DEV_DOCK_BADGE_LABEL ?? null,
        dockTitle: process.env.ORCA_DEV_DOCK_TITLE ?? null,
        stableName: process.env.ORCA_DEV_STABLE_NAME ?? null,
        electronExecPath: process.env.ELECTRON_EXEC_PATH ?? null
      },
      null,
      2
    ),
    'utf8'
  )
}
// The wrapper detaches this process group; exit with it so a killed test run cannot orphan us.
const parentPid = process.ppid
setInterval(() => {
  if (process.ppid !== parentPid) {
    exitAfterGrandchild('SIGTERM', 143)
  }
}, 1000)
