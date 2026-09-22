import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import policy from './windows-runtime-pipe-broker-package-policy.cjs'

const { assertWindowsRuntimePipeBrokerAbsent, windowsRuntimePipeBrokerResourcesForChannel } = policy

describe('Windows runtime pipe broker package policy', () => {
  it('selects the broker only for the signed release channel', () => {
    assert.deepEqual(windowsRuntimePipeBrokerResourcesForChannel('release'), [
      {
        from: 'native/windows-runtime-pipe-broker/.build/orca-pipe-broker.exe',
        to: 'bin/orca-pipe-broker.exe'
      }
    ])
    for (const channel of ['hourly', 'daily', 'adhoc']) {
      assert.deepEqual(windowsRuntimePipeBrokerResourcesForChannel(channel), [])
    }
  })

  it('rejects unknown channels instead of guessing their signing policy', () => {
    assert.throws(() => windowsRuntimePipeBrokerResourcesForChannel('local'), /Unknown/)
  })

  it('fails packaging if an unsigned payload contains the broker', () => {
    const resources = mkdtempSync(join(tmpdir(), 'orca-unsigned-broker-policy-'))
    mkdirSync(join(resources, 'bin'))
    writeFileSync(join(resources, 'bin', 'orca-pipe-broker.exe'), 'must-not-ship')
    assert.throws(() => assertWindowsRuntimePipeBrokerAbsent(resources), /must not contain/)
  })

  it('accepts an unsigned payload with no broker', () => {
    const resources = mkdtempSync(join(tmpdir(), 'orca-unsigned-broker-policy-'))
    assert.doesNotThrow(() => assertWindowsRuntimePipeBrokerAbsent(resources))
  })

  it('applies the selection to electron-builder for every Windows channel', () => {
    const probe = String.raw`
      const config = require('./config/electron-builder.config.cjs')
      const selected = config.win.extraResources.filter(
        (resource) => resource.to === 'bin/orca-pipe-broker.exe'
      )
      process.stdout.write(JSON.stringify(selected))
    `
    for (const [channel, variable] of [
      ['release', null],
      ['hourly', 'ORCA_WIN_HOURLY'],
      ['daily', 'ORCA_WIN_DAILY'],
      ['adhoc', 'ORCA_WIN_ADHOC']
    ]) {
      const env = { ...process.env }
      delete env.ORCA_WIN_HOURLY
      delete env.ORCA_WIN_DAILY
      delete env.ORCA_WIN_ADHOC
      if (variable) env[variable] = '1'
      const result = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', env })
      assert.equal(result.status, 0, `${channel}: ${result.stderr}`)
      const selected = JSON.parse(result.stdout)
      assert.equal(selected.length, channel === 'release' ? 1 : 0, channel)
    }
  })
})
