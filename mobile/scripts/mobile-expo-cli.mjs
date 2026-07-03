import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const expoBinNames =
  process.platform === 'win32' ? ['expo.CMD', 'expo.cmd', 'expo.ps1', 'expo'] : ['expo']

function expoBinPaths(mobileDir) {
  return expoBinNames.map((binName) => path.join(mobileDir, 'node_modules', '.bin', binName))
}

export function getMobileExpoExecutablePath(mobileDir) {
  return expoBinPaths(mobileDir).find((binPath) => existsSync(binPath)) ?? null
}

function runPnpmInstall(mobileDir) {
  return new Promise((resolve, reject) => {
    const install = spawn('pnpm', ['install', '--frozen-lockfile'], {
      cwd: mobileDir,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit'
    })
    install.on('error', reject)
    install.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`pnpm install --frozen-lockfile was terminated by ${signal}`))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(`pnpm install --frozen-lockfile exited with code ${code}`))
      }
    })
  })
}

export async function ensureMobileExpoCli(mobileDir, logger = {}) {
  if (getMobileExpoExecutablePath(mobileDir)) {
    return
  }

  const message = 'Mobile dependencies are missing; running pnpm install --frozen-lockfile...'
  if (logger.logStep) {
    logger.logStep('deps', message)
  } else {
    console.log(`[start] ${message}`)
  }

  await runPnpmInstall(mobileDir)

  if (!getMobileExpoExecutablePath(mobileDir)) {
    throw new Error('pnpm install completed, but node_modules/.bin/expo is still missing.')
  }

  logger.logSuccess?.('Mobile dependencies installed')
}
