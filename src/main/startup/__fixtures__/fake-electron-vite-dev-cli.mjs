import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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

// Why: wrapper tests must clean up both the fake electron-vite CLI process and
// the spawned Electron-like descendant if the assertion fails before SIGINT.
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
setInterval(() => {}, 1000)
