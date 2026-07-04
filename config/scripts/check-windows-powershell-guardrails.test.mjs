import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  checkWindowsPowerShellBuiltGuardrails,
  checkWindowsPowerShellGuardrails,
  checkWindowsPowerShellSourceGuardrails
} from './check-windows-powershell-guardrails.mjs'

const tempRoots = []

function createRepoFixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-pwsh-guardrails-'))
  tempRoots.push(root)
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = path.join(root, relativePath)
    mkdirSync(path.dirname(filePath), { recursive: true })
    writeFileSync(filePath, contents)
  }
  return root
}

describe('check-windows-powershell-guardrails', () => {
  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports direct bare pwsh process launches in source files', () => {
    const root = createRepoFixture({
      'src/main/pwsh-probe.ts': "execFileSync('pwsh.exe', ['-Version'])"
    })

    expect(checkWindowsPowerShellSourceGuardrails(root)).toMatchObject([
      { ruleId: 'bare-pwsh-process-launch' }
    ])
  })

  it('accepts PowerShell launches through a resolved executable variable', () => {
    const root = createRepoFixture({
      'src/main/pwsh-probe.ts':
        "const shell = resolveWindowsPowerShellExecutablePath('pwsh.exe'); execFileSync(shell, ['-Version'])"
    })

    expect(checkWindowsPowerShellGuardrails(root)).toEqual([])
  })

  it('reports relay imports that reach back into main providers', () => {
    const root = createRepoFixture({
      'src/relay/windows-shell.ts':
        "import { resolveWindowsPowerShellSpawnChain } from '../main/providers/windows-powershell-executable'"
    })

    expect(checkWindowsPowerShellSourceGuardrails(root)).toMatchObject([
      { ruleId: 'relay-main-powershell-resolver-import' }
    ])
  })

  it('ignores regression fixtures in test files', () => {
    const root = createRepoFixture({
      'src/main/pwsh-probe.test.ts': "execFileSync('pwsh.exe', ['-Version'])"
    })

    expect(checkWindowsPowerShellSourceGuardrails(root)).toEqual([])
  })

  it('scans built output when packaged files are present', () => {
    const root = createRepoFixture({
      'out/main/index.js': 'require("node:child_process").execFileSync("pwsh.exe",["-Version"])'
    })

    expect(checkWindowsPowerShellBuiltGuardrails(root)).toMatchObject([
      { ruleId: 'packaged-bare-pwsh-probe' }
    ])
  })
})
