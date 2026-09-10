import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('electron-vite dev supervisor', () => {
  it.skipIf(process.platform === 'win32')(
    'exits when the dev CLI leaves inherited output open',
    () => {
      const directory = mkdtempSync(join(tmpdir(), 'orca-dev-supervisor-'))
      temporaryDirectories.push(directory)
      const inheritedOutputPidFile = join(directory, 'inherited-output.pid')
      const fakeElectronVite = join(directory, 'fake-electron-vite.mjs')
      writeFileSync(
        fakeElectronVite,
        `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const inheritedOutput = spawn(process.execPath, ['--eval', 'setInterval(() => undefined, 60_000)'], {
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit']
})
inheritedOutput.unref()
writeFileSync(${JSON.stringify(inheritedOutputPidFile)}, String(inheritedOutput.pid))
process.exit(29)
`
      )
      const supervisorUrl = pathToFileURL(
        resolve('config/scripts/electron-vite-dev-supervisor.mjs')
      ).href
      const runner = `
import { runElectronViteDevSupervisor } from ${JSON.stringify(supervisorUrl)}
runElectronViteDevSupervisor({
  nodePath: process.execPath,
  electronViteCli: ${JSON.stringify(fakeElectronVite)},
  args: [],
  env: { ...process.env }
})
`
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', runner], {
        encoding: 'utf8',
        killSignal: 'SIGKILL',
        timeout: 2_000
      })

      const inheritedOutputPid = Number.parseInt(readFileSync(inheritedOutputPidFile, 'utf8'), 10)
      try {
        process.kill(inheritedOutputPid, 'SIGKILL')
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null
        if (code !== 'ESRCH') {
          throw error
        }
      }
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      expect(result.status).toBe(29)
    }
  )

  it('exits after the bounded software-rendering retry also fails', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-dev-supervisor-'))
    temporaryDirectories.push(directory)
    const fakeElectronVite = join(directory, 'fake-electron-vite.mjs')
    writeFileSync(
      fakeElectronVite,
      `if (process.env.ORCA_DEV_GPU_FALLBACK === '1') {
  process.exit(23)
}
console.error('GPU process launch failed: error_code=1002\\nGPU process launch failed: error_code=1002\\nGPU process launch failed: error_code=1002')
setInterval(() => undefined, 1_000)
`
    )
    const supervisorUrl = pathToFileURL(
      resolve('config/scripts/electron-vite-dev-supervisor.mjs')
    ).href
    const runner = `
import { runElectronViteDevSupervisor } from ${JSON.stringify(supervisorUrl)}
runElectronViteDevSupervisor({
  nodePath: process.execPath,
  electronViteCli: ${JSON.stringify(fakeElectronVite)},
  args: [],
  env: { ...process.env }
})
`
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', runner], {
      encoding: 'utf8',
      timeout: 5_000
    })

    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status).toBe(23)
    expect(result.stderr).toContain(
      '[gpu-fallback] GPU startup is failing; restarting this dev run once with software rendering.'
    )
  })
})
