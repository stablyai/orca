#!/usr/bin/env node

import { spawn } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { ensureMobileExpoCli } from './mobile-expo-cli.mjs'

const scriptDir = import.meta.dirname
const mobileDir = path.resolve(scriptDir, '..')

function pnpmCommand(args) {
  return {
    command: 'pnpm',
    args,
    shell: process.platform === 'win32'
  }
}

function runPnpm(args) {
  const pnpm = pnpmCommand(args)
  return new Promise((resolve, reject) => {
    const child = spawn(pnpm.command, pnpm.args, {
      cwd: mobileDir,
      env: process.env,
      shell: pnpm.shell,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`pnpm ${args.join(' ')} was terminated by ${signal}`))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(`pnpm ${args.join(' ')} exited with code ${code}`))
      }
    })
  })
}

async function main() {
  await ensureMobileExpoCli(mobileDir)
  await runPnpm(['exec', 'expo', 'start', ...process.argv.slice(2)])
}

main().catch((error) => {
  console.error(`[start] ${error.message}`)
  process.exit(1)
})
