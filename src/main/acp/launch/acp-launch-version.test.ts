import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { rememberManagedAgentRelease } from '../../managed-agent-cli/managed-agent-cli-registry'
import { acpLaunchSpecFor } from './acp-launch-registry'
import { acpOwnProgramTooOld, checkAcpLaunchVersionOrCopy } from './acp-launch-version'

let folder = ''
afterEach(() => {
  rememberManagedAgentRelease('antigravity', null)
  rmSync(folder, { recursive: true, force: true })
})

it("stands Orca's agy in for the person's own agy that is too old, unless it is switched off", async () => {
  folder = mkdtempSync(join(tmpdir(), 'orcas-agy-'))
  const copy = join(folder, process.platform === 'win32' ? 'agy.exe' : 'agy')
  writeFileSync(copy, '')
  rememberManagedAgentRelease('antigravity', folder)
  const spec = acpLaunchSpecFor('antigravity')!
  const read = async ({ program }: { program: string }) => ({
    version: program === copy ? '1.5.13' : '1.5.2'
  })
  const launch = { command: '/usr/local/bin/agy', prefixArgs: [], cwd: folder, env: {} }

  const on = await checkAcpLaunchVersionOrCopy(spec, launch, false, read, {})
  expect(on).toMatchObject({ command: copy, check: { status: 'ready', version: '1.5.13' } })

  const off = await checkAcpLaunchVersionOrCopy(spec, launch, false, read, {
    antigravityManagedAgyEnabled: false
  })
  expect(off).toMatchObject({ command: '/usr/local/bin/agy', check: { status: 'tooOld' } })
})

it("keeps the own program when Orca's copy is missing", async () => {
  folder = mkdtempSync(join(tmpdir(), 'orcas-agy-'))
  const copy = join(folder, process.platform === 'win32' ? 'agy.exe' : 'agy')
  writeFileSync(copy, '')
  rememberManagedAgentRelease('antigravity', folder)
  const spec = acpLaunchSpecFor('antigravity')!
  const read = async ({
    program
  }: {
    program: string
  }): Promise<{ version: string | null; started?: false }> =>
    program === copy ? { version: null, started: false } : { version: '1.5.2' }
  const launch = { command: '/usr/local/bin/agy', prefixArgs: [], cwd: folder, env: {} }

  const settled = await checkAcpLaunchVersionOrCopy(spec, launch, false, read, {})
  expect(settled).toMatchObject({ command: '/usr/local/bin/agy', check: { status: 'tooOld' } })
})

it("reads an own program's version once per binary, and never starts it without a probe", async () => {
  folder = mkdtempSync(join(tmpdir(), 'own-agy-'))
  const own = join(folder, 'agy')
  writeFileSync(own, '#!/bin/sh\necho 1.5.4\n', { mode: 0o755 })
  const spec = { minimumVersions: ['1.5.5'] }
  const env: Record<string, string> = { PATH: process.env.PATH ?? '' }
  expect(await acpOwnProgramTooOld(spec, own, env, { probe: false })).toBe(false)
  if (process.platform !== 'win32') {
    expect(await acpOwnProgramTooOld(spec, own, env, { probe: true })).toBe(true)
    expect(await acpOwnProgramTooOld(spec, own, env, { probe: false })).toBe(true)
  }
})
