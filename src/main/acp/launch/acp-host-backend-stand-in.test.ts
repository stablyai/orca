import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { rememberManagedAgentRelease } from '../../managed-agent-cli/managed-agent-cli-registry'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../../antigravity/antigravity-acp-launch-spec'
import { acpHostBackendInput } from './acp-launch-command'

let root = ''
afterEach(() => {
  rememberManagedAgentRelease('antigravity', null)
  rmSync(root, { recursive: true, force: true })
})

it.skipIf(process.platform === 'win32')(
  "asks Orca's installed agy instead of an own agy below the floor, unless it is switched off",
  async () => {
    root = mkdtempSync(join(tmpdir(), 'agy-stand-in-'))
    const bin = join(root, 'bin')
    // Orca's releases sit side by side under one folder, which a copy path is judged by.
    const copyFolder = join(root, 'agent-runtimes', 'agy', '1.5.13')
    mkdirSync(bin)
    mkdirSync(copyFolder, { recursive: true })
    const own = join(bin, 'agy')
    writeFileSync(own, '#!/bin/sh\necho 1.5.4\n', { mode: 0o755 })
    writeFileSync(join(copyFolder, 'agy'), '', { mode: 0o755 })
    rememberManagedAgentRelease('antigravity', copyFolder)
    const env = { PATH: bin, HOME: root }
    const ask = (antigravityManagedAgyEnabled: boolean) =>
      acpHostBackendInput(
        ANTIGRAVITY_LAUNCH_SPEC,
        env,
        root,
        { antigravityManagedAgyEnabled },
        { startsProgram: true, inherited: {} }
      )

    expect((await ask(true))?.command).toBe(join(copyFolder, 'agy'))
    expect((await ask(false))?.command).toBe(own)
  }
)
