import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const grandchildPath = path.join(__dirname, 'electron-vite-dev-grandchild.mjs')
const pidFile = process.env.ORCA_DEV_WRAPPER_TEST_PID_FILE

const grandchild = spawn(process.execPath, [grandchildPath], {
  stdio: 'ignore'
})

if (!pidFile) {
  throw new Error('ORCA_DEV_WRAPPER_TEST_PID_FILE is required')
}

writeFileSync(pidFile, `${grandchild.pid ?? ''}\n`, 'utf8')
setInterval(() => {}, 1000)
