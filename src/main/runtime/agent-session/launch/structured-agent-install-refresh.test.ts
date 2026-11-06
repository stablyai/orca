import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveCliCommand } from '../../../../shared/node-cli-command-resolution'

import { resolveClaudeChildEnvSources } from '../../../claude/structured/launch/claude-structured-child-env'

const roots: string[] = []

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

/**
 * A host whose shell env was read before an agent was installed into a folder only the profile
 * puts on PATH, as in the live check over SSH; only a reread sees it. `name` is unique so nothing
 * on the machine running the test can answer for it.
 */
function hostInstallingAfterFirstCapture(name: string) {
  const root = mkdtempSync(join(tmpdir(), 'orca-install-after-capture-'))
  roots.push(root)
  const profileBin = join(root, 'profile-bin')
  mkdirSync(profileBin)
  const program = join(profileBin, process.platform === 'win32' ? `${name}.cmd` : name)
  writeFileSync(program, '#!/bin/sh\nexit 0\n')
  chmodSync(program, 0o755)
  let served = '/usr/bin'
  const environment = {
    resolveBaseEnvironment: async () => ({ PATH: served, HOME: root }),
    refreshAfterMissingProgram: vi.fn(async (_askedAt: number) => {
      served = profileBin
    })
  }
  return { environment, program, profileBin }
}

describe('an agent installed after the first shell capture', () => {
  it("starts Claude's first chat, from the refreshed environment", async () => {
    const name = `claude-l5-${process.pid}`
    const host = hostInstallingAfterFirstCapture(name)
    const sources = await resolveClaudeChildEnvSources({
      resolveInheritedEnv: host.environment.resolveBaseEnvironment,
      refreshEnvironmentAfterMiss: host.environment.refreshAfterMissingProgram,
      resolveCommand: (options) => ({ command: resolveCliCommand(name, options), prefixArgs: [] })
    })
    expect(sources.command).toBe(host.program)
    expect(sources.inheritedEnv.PATH).toBe(host.profileBin)
  })
})
