import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { buildMacShipItScheduling } = require('./macos-shipit-scheduling.cjs')
const root = resolve(import.meta.dirname, '../..')

describe.skipIf(process.platform !== 'darwin')('native ShipIt scheduling', () => {
  it('changes only ProcessType in the real Electron job, retaining native install and retry settings', () => {
    const work = mkdtempSync(join(tmpdir(), 'orca-shipit-contract-'))
    const bundleId = `com.orca.shipit-contract.${work.split('-').at(-1).toLowerCase()}`
    try {
      for (const arch of ['x64', 'arm64']) {
        buildMacShipItScheduling(join(work, arch), arch)
      }
      const addon = join(work, process.arch, 'orca_shipit_scheduling.node')
      // Loading outside Electron must fail safely when Squirrel is absent.
      expect(require(addon).configure()).toBe(false)
      const compatibilityProbe = join(work, 'unsupported-api')
      execFileSync('/usr/bin/clang', [
        '-fobjc-arc',
        '-framework',
        'Foundation',
        join(root, 'native/macos-shipit-scheduling/probe-unsupported-api.m'),
        '-o',
        compatibilityProbe
      ])
      for (const mode of [
        'return-type',
        'object',
        'payload',
        'exception',
        'thrown-object',
        'supported'
      ]) {
        execFileSync(compatibilityProbe, [addon, mode], { timeout: 20_000 })
      }
      const contents = join(work, 'Probe.app', 'Contents')
      const executable = join(contents, 'MacOS', 'probe')
      mkdirSync(dirname(executable), { recursive: true })
      writeFileSync(
        join(contents, 'Info.plist'),
        `<?xml version="1.0"?><plist version="1.0"><dict>
        <key>CFBundleIdentifier</key><string>${bundleId}</string>
        <key>CFBundleExecutable</key><string>probe</string></dict></plist>`
      )
      execFileSync('/usr/bin/clang', [
        '-fobjc-arc',
        '-framework',
        'Foundation',
        join(root, 'native/macos-shipit-scheduling/probe-job-dictionary.m'),
        '-o',
        executable
      ])
      const electron = require('electron')
      expect(
        execFileSync(electron, ['-e', 'console.log(require(process.argv[1]).configure())', addon], {
          encoding: 'utf8',
          timeout: 20_000,
          env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ELECTRON_RUN_AS_NODE: '1' }
        }).trim()
      ).toBe('true')
      const frameworks = resolve(dirname(electron), '../Frameworks')
      const job = JSON.parse(
        execFileSync(executable, [frameworks, addon], {
          encoding: 'utf8',
          timeout: 20_000,
          env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
        })
      )
      expect(job.ProcessType).toBe('Interactive')
      expect(job.Label).toBe(`${bundleId}.ShipIt`)
      expect(job.ProgramArguments).toEqual([
        join(frameworks, 'Squirrel.framework/Resources/ShipIt'),
        job.Label,
        join(homedir(), 'Library/Caches', job.Label, 'ShipItState.plist')
      ])
      expect(job.KeepAlive).toEqual({ SuccessfulExit: false })
      expect(job.MachServices).toEqual({ [job.Label]: true })
    } finally {
      rmSync(work, { recursive: true, force: true })
      rmSync(join(homedir(), 'Library/Caches', `${bundleId}.ShipIt`), {
        recursive: true,
        force: true
      })
    }
  }, 90_000)
})
